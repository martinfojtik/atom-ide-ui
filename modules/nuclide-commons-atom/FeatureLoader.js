/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

/* global localStorage */

import invariant from 'assert';
import idx from 'idx';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import nullthrows from 'nullthrows';
import {activateExperimentalPackages} from './experimental-packages';
import featureConfig from './feature-config';
import path from 'path'; // eslint-disable-line rulesdir/prefer-nuclide-uri
import {MultiMap, setUnion} from 'nuclide-commons/collection';

type FeaturePkg = {
  name: string,
  atomConfig?: Object,
  consumedServices?: Object,
  description?: string,
  displayName?: string,
  nuclide?: {
    config?: Object,
  },
  providedServices?: Object,
  featureGroups?: Array<string>,
};

export type Feature = {
  path: string,
  pkg: FeaturePkg,
};

type FeatureLoaderParams = {
  path: string,
  features: Array<Feature>,
  featureGroups?: {
    [string]: Array<string>,
  },
};

type UseFeatureRules = {
  [name: string]: 'always' | 'never' | 'default',
};

const ALWAYS_ENABLED = 'always';
const NEVER_ENABLED = 'never';
const DEFAULT = 'default';

const {devMode} = atom.getLoadSettings();

export const REQUIRED_FEATURE_GROUP = 'nuclide-required';

export default class FeatureLoader {
  _activationDisposable: ?UniversalDisposable;
  _loadDisposable: UniversalDisposable;

  _config: ?Object;
  _features: Array<Feature>;
  _featureGroups: MultiMap<string, Feature>;
  _pkgName: string;
  _path: string;
  _currentlyActiveFeatures: Set<Feature> = new Set();

  constructor({features, path: _path, featureGroups}: FeatureLoaderParams) {
    this._path = _path;
    this._features = reorderFeatures(features);
    this._loadDisposable = new UniversalDisposable();
    this._pkgName = packageNameFromPath(this._path);
    this._featureGroups = groupFeatures(
      this._features,
      featureGroups == null ? {} : featureGroups,
    );
  }

  // Build the config. Should occur with root package's load
  load(): void {
    invariant(!this._loadDisposable.disposed);

    // Add a dummy deserializer. This forces Atom to load Nuclide's main module
    // (this file) when the package is loaded, which is super important because
    // this module loads all of the Nuclide features. We could accomplish the same
    // thing by unsetting [the local storage value][1] that Atom uses to indicate
    // whether the main module load can be deferred, however, that would mean that
    // (for a brief time, at least), the flag would be set. If there were an error
    // during that time and we never got a chance to unset the flag, Nuclide
    // features would never load again!
    //
    // [1] https://github.com/atom/atom/blob/v1.9.8/src/package.coffee#L442
    this._loadDisposable.add(
      atom.deserializers.add({
        name: `${this._pkgName}.ForceMainModuleLoad`,
        deserialize() {},
      }),
    );

    featureConfig.setPackageName(this._pkgName);

    //
    // Build the "config" object. This determines the config defaults and
    // it's what is shown by the Settings view. It includes:
    // (1) An entry to enable/disable each feature - called "${pkgName}.use.*".
    // (2) Each feature's merged config.
    //
    // https://atom.io/docs/api/latest/Config
    //
    this._config = buildConfig(this._features);

    // Load enabled features. This needs to be done during Atom's load phase to
    // make sure that deserializers are registered, etc.
    // https://github.com/atom/atom/blob/v1.1.0/src/atom-environment.coffee#L625-L631
    // https://atom.io/docs/api/latest/PackageManager
    this._loadDisposable.add(
      // Nesting loads within loads leads to reverse activation order- that is, if
      // the root package loads feature packages, then the feature package activations will
      // happen before the root package's. So we wait until the root package is done loading,
      // but before it activates, to load the features.
      whenPackageLoaded(this._pkgName, () => {
        const featuresToLoad = this.getEnabledFeatures();
        // Load "regular" feature packages.
        featuresToLoad.forEach(feature => {
          atom.packages.loadPackage(feature.path);
        });
        // Load "experimental" format packages.
        return activateExperimentalPackages([...featuresToLoad]);
      }),
    );
  }

  activate(): void {
    invariant(this._activationDisposable == null);
    const rootPackage = atom.packages.getLoadedPackage(this._pkgName);
    invariant(rootPackage != null);

    // This is a failsafe in case the `.ForceMainModuleLoad` deserializer
    // defined above does not register in time, or if the defer key has been set
    // w/o our knowledge. This can happen during OSS upgrades.
    localStorage.removeItem(
      rootPackage.getCanDeferMainModuleRequireStorageKey(),
    );

    // Watch the config to manage toggling features
    this._activationDisposable = new UniversalDisposable(
      atom.config.onDidChange(this.getUseKeyPath(), event =>
        this.updateActiveFeatures(),
      ),
      atom.config.onDidChange(this.getEnabledFeatureGroupsKeyPath(), event =>
        this.updateActiveFeatures(),
      ),
    );

    this.updateActiveFeatures();
  }

  /**
   * Enable and disable the correct features according to the current configuration.
   */
  updateActiveFeatures() {
    const featuresToActivate = this.getEnabledFeatures();

    // Enable all packages in featuresToActivate but not in currentState.
    // Disable all packages not in featuresToActivate but in currentState.
    for (const feature of featuresToActivate) {
      if (!this._currentlyActiveFeatures.has(feature)) {
        atom.packages.activatePackage(feature.path);
      }
    }

    for (const feature of this._currentlyActiveFeatures) {
      if (!featuresToActivate.has(feature)) {
        safeDeactivate(feature);
      }
    }

    this._currentlyActiveFeatures = featuresToActivate;
  }

  deactivate(): void {
    invariant(
      this._activationDisposable && !this._activationDisposable.disposed,
    );

    this._currentlyActiveFeatures.forEach(feature => {
      // Deactivate the package, but don't serialize. That needs to be done in a separate phase so that
      // we don't end up disconnecting a service and then serializing the disconnected state.
      safeDeactivate(feature, true);
    });
    this._currentlyActiveFeatures = new Set();

    invariant(this._activationDisposable); // reasserting for flow
    this._activationDisposable.dispose();
    this._activationDisposable = null;
  }

  /**
   * Determine which features are enabled based on the current state of the configuration. This set
   * is then used to load and activate the features.
   */
  getEnabledFeatures(): Set<Feature> {
    // we know enabledFeatureGroups must be ?Array, and useFeatureRules must be ?UseFeatureRules,
    // since it's in our schema. However, flow thinks it's a mixed type, since it doesn't know about
    // the schema enforcements.
    const useFeatureRules: ?UseFeatureRules = (atom.config.get(
      this.getUseKeyPath(),
    ): any);
    const enabledFeatureGroups: ?Array<string> = (atom.config.get(
      this.getEnabledFeatureGroupsKeyPath(),
    ): any);

    let featuresInEnabledGroups;
    if (enabledFeatureGroups != null) {
      featuresInEnabledGroups = setUnion(
        ...enabledFeatureGroups.map(featureGroup =>
          this._featureGroups.get(featureGroup),
        ),
      );
    } else {
      // If featuregroups is empty or undefined, assume all features should be enabled.
      featuresInEnabledGroups = new Set(this._features);
    }

    const requiredFeatures =
      this._featureGroups.get(REQUIRED_FEATURE_GROUP) || new Set();

    // If a feature is "always enabled", it should be on whether or not a feature-group includes it.
    // If a feature is "default", it should be on if and only if a feature-group includes it.
    return new Set(
      this._features.filter(feature => {
        const featureName = packageNameFromPath(feature.path);
        const rawRule = idx(useFeatureRules, _ => _[featureName]);
        const rule =
          rawRule == null ? getFeatureDefaultValue(feature) : rawRule;
        return (
          rule === ALWAYS_ENABLED ||
          rule === true ||
          (featuresInEnabledGroups.has(feature) && rule === DEFAULT) ||
          requiredFeatures.has(feature)
        );
      }),
    );
  }

  getConfig(): Object {
    invariant(this._config != null);
    return this._config;
  }

  serialize(): void {
    // When the root package is serialized, all of its features need to be serialized. This is an abuse of
    // `serialize()` since we're using it to do side effects instead of returning the serialization,
    // but it ensures that serialization of the Atom packages happens at the right point in the
    // package lifecycle. Unfortunately, it also means that Nuclide features will be serialized twice
    // on deactivation.
    this._features.forEach(safeSerialize);
  }

  getUseKeyPath(): string {
    return `${this._pkgName}.use`;
  }

  getEnabledFeatureGroupsKeyPath(): string {
    return `${this._pkgName}.enabledFeatureGroups`;
  }
}

function safeDeactivate(
  feature: Feature,
  suppressSerialization: boolean = false,
) {
  const name = packageNameFromPath(feature.path);
  try {
    const pack = atom.packages.getLoadedPackage(name);
    if (pack != null) {
      atom.packages.deactivatePackage(name, suppressSerialization);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error deactivating "${name}": ${err.message}`);
  }
}

function getFeatureDefaultValue(feature: Feature): string {
  const name = packageNameFromPath(feature.path);
  return name.startsWith('sample-') ? NEVER_ENABLED : DEFAULT;
}

function safeSerialize(feature: Feature) {
  const name = packageNameFromPath(feature.path);
  try {
    const pack = atom.packages.getActivePackage(name);
    if (pack != null) {
      // Serialize the package
      atom.packages.serializePackage(pack);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error serializing "${name}": ${err.message}`);
  }
}

// this could be inlined into its use above, but this makes the intent more
// explicit, and unifies it in the case this ever needs to change.
function packageNameFromPath(pkgPath: string): string {
  return path.basename(pkgPath);
}

function packageIsRepositoryProvider(pkg: FeaturePkg): boolean {
  return Boolean(idx(pkg, _ => _.providedServices['atom.repository-provider']));
}

function buildConfig(features: Array<Feature>): Object {
  const config = {
    use: {
      title: 'Enabled Features',
      description: 'Enable and disable individual features',
      type: 'object',
      collapsed: true,
      properties: {},
    },
  };
  features.forEach(feature => {
    const featurePkg = feature.pkg;
    const name = packageNameFromPath(feature.path);

    const setting = {
      title:
        featurePkg.displayName == null
          ? `Enable the "${name}" feature`
          : `Enable ${featurePkg.displayName}`,
      description: featurePkg.description || '',
      type: 'string',
      enum: [
        {value: ALWAYS_ENABLED, description: 'Always enabled'},
        {value: NEVER_ENABLED, description: 'Never enabled'},
        {
          value: DEFAULT,
          description: 'Only when in an enabled package group',
        },
      ],
      default: getFeatureDefaultValue(feature),
    };

    if (devMode) {
      if (featurePkg.providedServices) {
        const provides = Object.keys(featurePkg.providedServices).join(', ');
        setting.description += `<br/>**Provides:** _${provides}_`;
      }
      if (featurePkg.consumedServices) {
        const consumes = Object.keys(featurePkg.consumedServices).join(', ');
        setting.description += `<br/>**Consumes:** _${consumes}_`;
      }
    }

    config.use.properties[name] = setting;

    // Merge in the feature's config
    const featurePkgConfig =
      featurePkg.atomConfig ||
      (featurePkg.nuclide && featurePkg.nuclide.config);

    if (featurePkgConfig) {
      config[name] = {
        type: 'object',
        title: featurePkg.displayName,
        description: featurePkg.description,
        collapsed: true,
        properties: {},
      };
      Object.keys(featurePkgConfig).forEach(key => {
        config[name].properties[key] = {
          ...featurePkgConfig[key],
          title: featurePkgConfig[key].title || key,
        };
      });
    }
  });
  return config;
}

function whenPackageLoaded(
  pkgName: string,
  callback: () => IDisposable,
): IDisposable {
  const disposables = new UniversalDisposable();
  const onDidLoadDisposable = atom.packages.onDidLoadPackage(pack => {
    if (pack.name !== pkgName) {
      return;
    }

    // We only want this to happen once.
    onDidLoadDisposable.dispose();

    disposables.add(callback());
  });
  disposables.add(onDidLoadDisposable);
  return disposables;
}

/**
 * Hack time!! Atom's repository APIs are synchronous. Any package that tries to use them before
 * we've had a chance to provide our implementation are going to get wrong answers. The correct
 * thing to do would be to always go through an async API that awaits until
 * `atom.packages.onDidActivateInitialPackages()` completes. However, we have some legacy sync
 * codepaths that make that difficult. As a temporary (I hope) workaround, we prioritize
 * activation of the features that provide this service.
 */
function reorderFeatures(features_: Array<Feature>): Array<Feature> {
  const features = features_.slice();
  const originalOrder = new Map(features.map((feature, i) => [feature, i]));
  features.sort((a, b) => {
    const aIsRepoProvider = packageIsRepositoryProvider(a.pkg);
    const bIsRepoProvider = packageIsRepositoryProvider(b.pkg);
    if (aIsRepoProvider !== bIsRepoProvider) {
      return aIsRepoProvider ? -1 : 1;
    }
    const aIndex = nullthrows(originalOrder.get(a));
    const bIndex = nullthrows(originalOrder.get(b));
    return aIndex - bIndex;
  });
  return features;
}

/**
 * Construct a map whose keys are feature group names and values are sets of features belonging to
 * the group.
 */
function groupFeatures(
  features: Array<Feature>,
  rawFeatureGroups: {
    [string]: Array<string>,
  },
): MultiMap<string, Feature> {
  const namesToFeatures = new Map();
  features.forEach(feature => {
    namesToFeatures.set(path.basename(feature.path), feature);
  });

  const featureGroups = new MultiMap();
  for (const key of Object.keys(rawFeatureGroups)) {
    if (Array.isArray(rawFeatureGroups[key])) {
      const featuresForKey = rawFeatureGroups[key]
        .map(featureName => namesToFeatures.get(featureName))
        .filter(Boolean);
      if (featuresForKey != null) {
        featureGroups.set(key, featuresForKey);
      }
    }
  }
  return featureGroups;
}
