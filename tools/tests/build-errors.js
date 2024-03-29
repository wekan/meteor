var selftest = require('../tool-testing/selftest.js');
var Sandbox = selftest.Sandbox;

// This test was originally written to test the behavior of parse-stack.ts when
// there's a colon in a filename. We now try a lot harder to avoid putting
// colons in filenames. But it's still a decent test that errors in legacy
// source handlers work.
selftest.define("build errors - legacy handler error", async function () {
  var s = new Sandbox();
  await s.init();

  var run;

  await s.createApp("myapp", "build-errors");
  s.cd("myapp");
  run = s.run("build", "myapp.tgz");
  run.waitSecs(60);
  await run.matchErr("crash in plugin (compiling foo.awesome)");
  await run.expectExit(1);
  run.forbidAll("Couldn't parse stack");
});
