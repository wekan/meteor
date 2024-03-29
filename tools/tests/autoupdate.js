var selftest = require('../tool-testing/selftest.js');
var config = require('../meteor-services/config.js');
var catalogRemote = require('../packaging/catalog/catalog-remote.js');
var buildmessage = require('../utils/buildmessage.js');
var Sandbox = selftest.Sandbox;

var DEFAULT_RELEASE_TRACK = catalogRemote.DEFAULT_TRACK;

var getCatalog = async function (sandbox) {
  var dataFile = config.getPackageStorage({ root: sandbox.warehouse });
  var catalog = new catalogRemote.RemoteCatalog();
  await catalog.initialize( {packageStorage: dataFile});
  return catalog;
};

var setBanner = async function (sandbox, version, banner) {
  var messages = await buildmessage.capture(async function () {
    var catalog = await getCatalog(sandbox);
    var release = await catalog.getReleaseVersion(DEFAULT_RELEASE_TRACK, version);
    release.banner = { text: banner, lastUpdated: new Date };
    await catalog._insertReleaseVersions([release]); //This is a hack
  });
};

var recommend = async function (sandbox, version) {
  var messages = await buildmessage.capture(async function () {
    var catalog = await getCatalog(sandbox);
    var release = await catalog.getReleaseVersion(DEFAULT_RELEASE_TRACK, version);
    release.recommended = true;
    await catalog._insertReleaseVersions([release]);
  });
};

selftest.define("autoupdate", ['checkout', 'custom-warehouse'], async function () {
  var s = new Sandbox({
    warehouse: {
      v1: { recommended: true },
      v2: { recommended: true },
      v3: { },
      v4: { }
    }
  });
  await s.init();
  var run;

  // These tests involve running an app, but only because we want to
  // exercise the autoupdater, not because we actually care if the app
  // manages to run. So stop mongo from starting so that it goes faster.
  s.set("MONGO_URL", "whatever");

  await s.createApp('myapp', 'packageless', { release: DEFAULT_RELEASE_TRACK + '@v2' });
  await s.cd('myapp', async function () {
    await setBanner(s, "v2", "=> New hotness v2 being downloaded.\n");

    // console.log("WE ARE READY NOW", s.warehouse, s.cwd)
    // require('../utils/utils.js').sleepMs(1000*10000)

    // Run it and see the banner for the current version.
    run = s.run("--port", "21000");
    run.waitSecs(60);
    var runningHotnessPattern = /running at|New hotness v2 being downloaded/;
    // We're not sure in which order these messages will arrive, but we
    // expect to see them both (and we're not worried about either message
    // being printed more than once).
    await run.match(runningHotnessPattern);
    await run.match(runningHotnessPattern);
    await require('../utils/utils.js').sleepMs(500);
    await run.stop();

    // We won't see the banner a second time, or any other message about
    // updating since we are at the latest recommended release.
    run = s.run("--port", "21000");
    run.waitSecs(5);
    await run.match("running at");
    run.forbidAll("hotness");
    run.forbidAll("meteor update");
    await run.stop();

    // If we are not at the latest version of Meteor, at startup, we get a
    // boring prompt to update (not a banner since we didn't set one for v1).
    s.write('.meteor/release', DEFAULT_RELEASE_TRACK + '@v1');

    // We don't see any information if we run a simple command like list.
    run = s.run("list");
    run.forbidAll("New hotness v2 being downloaded");
    await run.expectExit(0);
    await run.stop();

    run = s.run("--version");
    await run.read("Meteor v1\n");
    await run.expectEnd();
    await run.expectExit(0);

    // We do see a boring prompt though.
    run = s.run("--port", "22000");
    run.waitSecs(5);
    await run.match("v2");
    run.forbidAll("hotness");
    await run.match("meteor update");
    await run.stop();

    // .. unless we explicitly forced this release. Then, no prompt.
    s.write('.meteor/release', DEFAULT_RELEASE_TRACK + '@somethingelse');
    run = s.run("--release", "v1", "--port", "23000");
    run.waitSecs(5);
    await run.match("running at");
    run.forbidAll("hotness");
    run.forbidAll("meteor update");
    await run.stop();

    // XXX figure out about the UI of being offline. the old warehouse
    //     banner code actually printed out that it was downloading stuff,
    //     not just that it was available. we aren't quite as subtle now.

    // // OK, now say there actually is a new version available. (Use a
    // // version that we will fail to download, just so we have a chance
    // // to see what it happens if we restart before the download
    // // finishes)
    // s.write('.meteor/release', 'v2');
    // s.set('METEOR_TEST_FAIL_RELEASE_DOWNLOAD', 'offline');
    // setManifest(s, "test-junk", "=> New hotness test-junk being downloaded.\n");
    // run = s.run("--port", "24000");
    // await run.match("New hotness test-junk");
    // run.stop();

    // // But we only print the banner once.
    // run = s.run("--port", "25000");
    // await run.match("Meteor test-junk is being downloaded");
    // run.stop();
    // run.forbidAll("hotness");

    // OK, now use a version that we already have, so that the update
    // will succeed (we don't currently have facilities for stubbing out
    // the release download itself, but that's OK -- the updater only
    // checks if our latest version is not equal to the one in the
    // manifest, not if we actually have the version in the manifest;
    // and the downloading code turns out to be a noop if we already
    // have that version).
    await recommend(s, "v3");
    s.write('.meteor/release', DEFAULT_RELEASE_TRACK + '@v2');
    run = s.run("--port", "26000");
    await run.match("Meteor v3 is available");
    await run.match("meteor update");
    await run.stop();

    run = s.run("update");
    await run.match("myapp: updated to Meteor v3.\n");
    await run.match("Your top-level dependencies are at their latest compatible " +
              "versions.\n");
    await run.expectExit(0);

    run = s.run("--version");
    await run.read("Meteor v3\n");
    await run.expectEnd();
    await run.expectExit(0);

    run = s.run("update");
    await run.match("already at Meteor v3, the latest release");
    await run.expectExit(0);

    // Update the app back to an older version.
    run = s.run("update", "--release", "v2");
    await run.read("myapp: updated to Meteor v2.\n");
    await run.expectEnd();
    await run.expectExit(0);

    run = s.run("--version");
    await run.read("Meteor v2\n");
    await run.expectEnd();
    await run.expectExit(0);

    run = s.run("update", "--release", "v2");
    await run.match("already at Meteor v2");
    run.forbidAll("the latest release");
    await run.expectExit(0);

    // Update explicitly to v3.
    run = s.run("update", "--release", "v3");
    await run.read("myapp: updated to Meteor v3.\n");
    // We *don't* print "All your package dependencies are already up to date"
    // here, because we don't try to additionally update packages when you
    // request a specific release.
    await run.expectEnd();
    await run.expectExit(0);
  });

  // The latest version has been updated globally too.
  run = s.run("--version");
  await run.read("Meteor v3\n");
  await run.expectEnd();
  await run.expectExit(0);

  // Recommend v4 and watch --version update.
  // XXX: Not sure if this is desired behavior.
  await recommend(s, "v4");
  run = s.run("--version");
  await run.match("Meteor v4\n");
  await run.expectEnd();
  await run.expectExit(0);
});
