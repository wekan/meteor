var _ = require('underscore');

var buildmessage = require('../utils/buildmessage.js');
var compiler = require('./compiler.js');
var files = require('../fs/files');
var isopackModule = require('./isopack.js');
var watch = require('../fs/watch');
var colonConverter = require('../utils/colon-converter.js');
var Profile = require('../tool-env/profile').Profile;
import { requestGarbageCollection } from "../utils/gc.js";

export class IsopackCache {
  constructor(options) {
    var self = this;
    options = options || {};

    // cacheDir may be null; in this case, we just don't ever save things to disk.
    self.cacheDir = options.cacheDir;

    // Root directory for caches used by build plugins.  Can be null, in which
    // case we never give the build plugins a cache.  The directory structure is:
    // <pluginCacheDirRoot>/<escapedPackageName>/<version>, where <version> is
    // either the package's version if it's a versioned package, or "local" if
    // it's a local package.  In the latter case, we make sure to empty it any
    // time we rebuild the package.
    self._pluginCacheDirRoot = options.pluginCacheDirRoot;

    // This is a bit of a hack, but basically: we really don't want to spend time
    // building web.cordova unibuilds in a project that doesn't have any Cordova
    // platforms. (Note that we need to be careful with 'meteor publish' to still
    // publish a web.cordova unibuild!)
    self._includeCordovaUnibuild = !! options.includeCordovaUnibuild;

    // Defines the versions of packages that we build. Must be set.
    self._packageMap = options.packageMap;

    // tropohouse may be null; in this case, we can't load versioned packages.
    // eg, for building isopackets.
    self._tropohouse = options.tropohouse;

    // If provided, this is another IsopackCache for the same cache dir; when
    // loading Isopacks, if they are definitely unchanged we can load the
    // in-memory objects from this cache instead of recompiling.
    self._previousIsopackCache = options.previousIsopackCache;
    if (self._previousIsopackCache &&
        self._previousIsopackCache.cacheDir !== self.cacheDir) {
      throw Error("previousIsopackCache has different cacheDir!");
    }

    // Map from package name to Isopack.
    self._isopacks = Object.create(null);

    self._lintLocalPackages = !! options.lintLocalPackages;
    self._lintPackageWithSourceRoot = options.lintPackageWithSourceRoot;

    self.allLoadedLocalPackagesWatchSet = new watch.WatchSet;
  }

  async buildLocalPackages(rootPackageNames) {
    var self = this;
    buildmessage.assertInCapture();

    if (self.cacheDir) {
      files.mkdir_p(self.cacheDir);
    }

    var onStack = {};
    if (rootPackageNames) {
      for (const name of rootPackageNames) {
        await self._ensurePackageLoaded(name, onStack);
      }
    } else {
      await self._packageMap.eachPackage(async function (name) {
        await self._ensurePackageLoaded(name, onStack);
        await requestGarbageCollection();
      });
    }
  }

  async wipeCachedPackages(packages) {
    var self = this;
    if (packages) {
      // Wipe specific packages.
      for (const packageName of packages) {
        if (self.cacheDir) {
          await files.rm_recursive(self._isopackDir(packageName));
        }
        if (self._pluginCacheDirRoot) {
          await files.rm_recursive(self._pluginCacheDirForPackage(packageName));
        }
      }
    } else {
      // Wipe all packages.
      if (self.cacheDir) {
        await files.rm_recursive(self.cacheDir);
      }
      if (self._pluginCacheDirRoot) {
        await files.rm_recursive(self._pluginCacheDirRoot);
      }
    }
  }

  // Returns the isopack (already loaded in memory) for a given name. It is an
  // error to call this if it's not already loaded! So it should only be called
  // after buildLocalPackages has returned, or in the process of building a
  // package whose dependencies have all already been built.
  getIsopack(name) {
    var self = this;
    if (! _.has(self._isopacks, name)) {
      throw Error("isopack " + name + " not yet loaded?");
    }
    return self._isopacks[name];
  }

  async eachBuiltIsopack(iterator) {
    var self = this;
    for (const [packageName, isopack] of Object.entries(self._isopacks)) {
      await iterator(packageName, isopack)
    }
  }

  getSourceRoot(name, arch) {
    const packageInfo = this._packageMap.getInfo(name);

    if (packageInfo) {
      if (packageInfo.kind === "local") {
        return packageInfo.packageSource.sourceRoot;
      }

      if (packageInfo.kind === "versioned") {
        const isopackPath = this._tropohouse.packagePath(
          name,
          packageInfo.version
        );

        return files.pathJoin(isopackPath, arch);
      }
    }

    return null;
  }

  uses(isopack, name, arch) {
    if (! isopack) {
      return false;
    }

    if (isopack.name === name) {
      // Packages use themselves.
      return true;
    }

    const unibuild = isopack.getUnibuildAtArch(arch);
    if (! unibuild) {
      return false;
    }

    for (const use of unibuild.uses) {
      const implies = this.implies(
          this._isopacks[use.package],
          name,
          arch,
      );

      if (implies) return implies;
    }
  }

  implies(isopack, name, arch) {
    if (! isopack) {
      return false;
    }

    if (isopack.name === name) {
      // Packages imply themselves.
      return true;
    }

    const unibuild = isopack.getUnibuildAtArch(arch);
    if (! unibuild) {
      return false;
    }

    for (const imp of unibuild.implies) {
      const implies = this.implies(
          this._isopacks[imp.package],
          name,
          arch,
      );

      if (implies) return implies;
    }
  }

  async _ensurePackageLoaded(name, onStack) {
    var self = this;
    buildmessage.assertInCapture();
    if (_.has(self._isopacks, name)) {
      return;
    }

    var ensureLoaded = async function (depName) {
      if (_.has(onStack, depName)) {
        buildmessage.error("circular dependency between packages " +
                           name + " and " + depName);
        // recover by not enforcing one of the dependencies
        return;
      }
      onStack[depName] = true;
      await self._ensurePackageLoaded(depName, onStack);
      delete onStack[depName];
    };

    var packageInfo = self._packageMap.getInfo(name);
    if (! packageInfo) {
      throw Error("Depend on unknown package " + name + "?");
    }
    var previousIsopack = null;
    if (self._previousIsopackCache &&
        _.has(self._previousIsopackCache._isopacks, name)) {
      var previousInfo = self._previousIsopackCache._packageMap.getInfo(name);
      if ((packageInfo.kind === 'versioned' &&
           previousInfo.kind === 'versioned' &&
           packageInfo.version === previousInfo.version) ||
          (packageInfo.kind === 'local' &&
           previousInfo.kind === 'local' &&
           (packageInfo.packageSource.sourceRoot ===
            previousInfo.packageSource.sourceRoot))) {
        previousIsopack = self._previousIsopackCache._isopacks[name];
      }
    }

    if (packageInfo.kind === 'local') {
      var packageNames =
            packageInfo.packageSource.getPackagesToLoadFirst(self._packageMap);
      await buildmessage.enterJob("preparing to build package " + name, async function () {
        for (const depName of packageNames) {
          await ensureLoaded(depName);
        }
        // If we failed to load something that this package depends on, don't
        // load it.
        if (buildmessage.jobHasMessages()) {
          return;
        }
        await Profile.time('IsopackCache Build local isopack', async () => {
          await self._loadLocalPackage(name, packageInfo, previousIsopack);
        });
      });
    } else if (packageInfo.kind === 'versioned') {
      // We don't have to build this package, and we don't have to build its
      // dependencies either! Just load it from disk.

      if (!self._tropohouse) {
        throw Error("Can't load versioned packages without a tropohouse!");
      }

      var isopack = null, packagesToLoad = [];

      await Profile.time('IsopackCache Load local isopack', async () => {
        if (previousIsopack) {
          // We can always reuse a previous Isopack for a versioned package, since
          // we assume that it never changes.  (Admittedly, this means we won't
          // notice if we download an additional build for the package.)
          isopack = previousIsopack;
          packagesToLoad = await isopack.getStrongOrderedUsedAndImpliedPackages();
        }
        if (! isopack) {
          // Load the isopack from disk.
          await buildmessage.enterJob(
            "loading package " + name + "@" + packageInfo.version,
            async function () {
              var pluginCacheDir;
              if (self._pluginCacheDirRoot) {
                pluginCacheDir = self._pluginCacheDirForVersion(
                  name, packageInfo.version);
                files.mkdir_p(pluginCacheDir);
              }
              var isopackPath = self._tropohouse.packagePath(
                name, packageInfo.version);

              var Isopack = isopackModule.Isopack;
              isopack = new Isopack();
              await isopack.initFromPath(name, isopackPath, {
                pluginCacheDir: pluginCacheDir
              });
              // If loading the isopack fails, then we don't need to look for more
              // packages to load, but we should still recover by putting it in
              // self._isopacks.
              if (buildmessage.jobHasMessages()) {
                return;
              }
              packagesToLoad = await isopack.getStrongOrderedUsedAndImpliedPackages();
            });
        }
      });

      self._isopacks[name] = isopack;
      // Also load its dependencies. This is so that if this package is being
      // built as part of a plugin, all the transitive dependencies of the
      // plugin are loaded.
      for (const packageToLoad of packagesToLoad) {
        await ensureLoaded(packageToLoad);
      }
    } else {
      throw Error("unknown packageInfo kind?");
    }
  }

  async _loadLocalPackage(name, packageInfo, previousIsopack) {
    var self = this;
    buildmessage.assertInCapture();
    await buildmessage.enterJob("building package " + name, async function () {
      var isopack;
      if (previousIsopack && await self._checkUpToDatePreloaded(previousIsopack)) {
        isopack = previousIsopack;
        // We don't need to call self._lintLocalPackage here, because
        // lintingMessages is saved on the isopack.
      } else {
        var pluginCacheDir;
        if (self._pluginCacheDirRoot) {
          pluginCacheDir = self._pluginCacheDirForLocal(name);
        }

        // Do we have an up-to-date package on disk?
        var isopackBuildInfoJson = self.cacheDir && files.readJSONOrNull(
          self._isopackBuildInfoPath(name));
        var upToDate = await self._checkUpToDate(isopackBuildInfoJson);

        if (upToDate) {
          // Reuse existing plugin cache dir
          pluginCacheDir && files.mkdir_p(pluginCacheDir);

          isopack = new isopackModule.Isopack();
          await isopack.initFromPath(name, self._isopackDir(name), {
            isopackBuildInfoJson: isopackBuildInfoJson,
            pluginCacheDir: pluginCacheDir
          });
          // _checkUpToDate already verified that
          // isopackBuildInfoJson.pluginProviderPackageMap is a subset of
          // self._packageMap, so this operation is correct. (It can't be done
          // by isopack.initFromPath, because Isopack doesn't have access to
          // the PackageMap, and specifically to the local catalog it knows
          // about.)
          isopack.setPluginProviderPackageMap(
            self._packageMap.makeSubsetMap(
              Object.keys(isopackBuildInfoJson.pluginProviderPackageMap)));
          // Because we don't save linter messages to disk, we have to relint
          // this package.
          // XXX save linter messages to disk?
          await self._lintLocalPackage(packageInfo.packageSource, isopack);
        } else {
          // Nope! Compile it again. Give it a fresh plugin cache.
          if (pluginCacheDir) {
            await files.rm_recursive(pluginCacheDir);
            files.mkdir_p(pluginCacheDir);
          }

          isopack = await compiler.compile(packageInfo.packageSource, {
            packageMap: self._packageMap,
            isopackCache: self,
            includeCordovaUnibuild: self._includeCordovaUnibuild,
            includePluginProviderPackageMap: true,
            pluginCacheDir: pluginCacheDir
          });
          // Accept the compiler's result, even if there were errors (since it
          // at least will have a useful WatchSet and will allow us to keep
          // going and compile other packages that depend on this one). However,
          // only lint it and save it to disk if there were no errors.
          if (! buildmessage.jobHasMessages()) {
            // Lint the package. We do this before saving so that the linter can
            // augment the saved-to-disk WatchSet with linter-specific files.
            await self._lintLocalPackage(packageInfo.packageSource, isopack);
            if (self.cacheDir) {
              // Save to disk, for next time!
              await isopack.saveToPath(self._isopackDir(name), {
                includeIsopackBuildInfo: true,
                isopackCache: self,
              });
            }
          }

          requestGarbageCollection();
        }
      }

      self.allLoadedLocalPackagesWatchSet.merge(isopack.getMergedWatchSet());
      self._isopacks[name] = isopack;
    });
  }

  // Runs appropriate linters on a package. It also augments their unibuilds'
  // WatchSets with files used by the linter.
  async _lintLocalPackage(packageSource, isopack) {
    buildmessage.assertInJob();
    if (!this._shouldLintPackage(packageSource)) {
      return;
    }
    const {warnings, linted} = await compiler.lint(packageSource, {
      isopackCache: this,
      isopack: isopack,
      includeCordovaUnibuild: this._includeCordovaUnibuild
    });
    // Empty lintingMessages means we ran linters and everything was OK.
    // lintingMessages left null means there were no linters to run.
    if (linted) {
      isopack.lintingMessages = warnings;
    }
  }

  _checkUpToDate(isopackBuildInfoJson) {
    var self = this;
    // If there isn't an isopack-buildinfo.json file, then we definitely aren't
    // up to date!
    if (! isopackBuildInfoJson) {
      return false;
    }

    // If we include Cordova but this Isopack doesn't, or via versa, then we're
    // not up to date.
    if (self._includeCordovaUnibuild !==
        isopackBuildInfoJson.includeCordovaUnibuild) {
      return false;
    }

    // Was the package built by a different compiler version?
    if (isopackBuildInfoJson.builtBy !== compiler.BUILT_BY) {
      return false;
    }

    // If any of the direct dependencies changed their version or location, we
    // aren't up to date.
    if (!self._packageMap.isSupersetOfJSON(
      isopackBuildInfoJson.pluginProviderPackageMap)) {
      return false;
    }
    // Merge in the watchsets for all unibuilds and plugins in the package, then
    // check it once.
    var watchSet = watch.WatchSet.fromJSON(
      isopackBuildInfoJson.pluginDependencies);

    _.each(isopackBuildInfoJson.unibuildDependencies, function (deps) {
      watchSet.merge(watch.WatchSet.fromJSON(deps));
    });
    return watch.isUpToDate(watchSet);
  }

  _checkUpToDatePreloaded(previousIsopack) {
    var self = this;

    // If we include Cordova but this Isopack doesn't, or via versa, then we're
    // not up to date.
    if (self._includeCordovaUnibuild !== previousIsopack.hasCordovaUnibuild()) {
      return false;
    }

    // We don't have to check builtBy because we don't change BUILT_BY without
    // restarting the process.

    // If any of the direct dependencies changed their version or location, we
    // aren't up to date.
    if (!self._packageMap.isSupersetOfJSON(
      previousIsopack.pluginProviderPackageMap.toJSON())) {
      return false;
    }
    // Merge in the watchsets for all unibuilds and plugins in the package, then
    // check it once.
    var watchSet = previousIsopack.getMergedWatchSet();
    return watch.isUpToDate(watchSet);
  }

  _isopackDir(packageName) {
    var self = this;
    return files.pathJoin(self.cacheDir, colonConverter.convert(packageName));
  }

  _pluginCacheDirForPackage(packageName) {
    var self = this;
    return files.pathJoin(self._pluginCacheDirRoot,
                          colonConverter.convert(packageName));
  }

  _pluginCacheDirForVersion(packageName, version) {
    var self = this;
    return files.pathJoin(
      self._pluginCacheDirForPackage(packageName), version);
  }

  _pluginCacheDirForLocal(packageName) {
    var self = this;
    // assumes that `local` is not a valid package version.
    return files.pathJoin(
      self._pluginCacheDirForPackage(packageName), 'local');
  }

  _isopackBuildInfoPath(packageName) {
    var self = this;
    return files.pathJoin(
      self._isopackDir(packageName), 'isopack-buildinfo.json');
  }

  forgetPreviousIsopackCache() {
    var self = this;
    self._previousIsopackCache = null;
  }

  _shouldLintPackage(packageSource) {
    if (this._lintLocalPackages) {
      return true;
    }
    if (! this._lintPackageWithSourceRoot) {
      return false;
    }
    return this._lintPackageWithSourceRoot === packageSource.sourceRoot;
  }

  async getLintingMessagesForLocalPackages() {
    const messages = new buildmessage._MessageSet();
    let anyLinters = false;

    await this._packageMap.eachPackage((name, packageInfo) => {
      const isopack = this._isopacks[name];
      if (packageInfo.kind === 'local') {
        if (!this._shouldLintPackage(packageInfo.packageSource)) {
          return;
        }
        const isopackMessages = isopack.lintingMessages;
        if (isopackMessages) {
          anyLinters = true;
          messages.merge(isopackMessages);
        }
      }
    });

    // return null if no linters were ever run
    if (! anyLinters) { return null; }

    return messages;
  }
}

const ICp = IsopackCache.prototype;
[ // Include any methods here that need profiling and take a package name
  // string as their first argument.
  "_ensurePackageLoaded",
].forEach(method => {
  ICp[method] = Profile(
    packageName => method + "(" + packageName + ")",
    ICp[method],
  );
});
