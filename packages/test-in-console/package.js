Package.describe({
  summary: 'Run tests noninteractively, with results going to the console.',
  version: '2.0.0-alpha300.17',
});

Package.onUse(function(api) {
  api.use(['tinytest', 'underscore', 'random', 'ejson', 'check']);
  api.use('http@1.0.1', 'server'); // TODO replace with fetch

  api.export('TEST_STATUS', 'client');

  api.addFiles(['driver.js', 'test.css'], 'client');

  api.addFiles(['reporter.js'], 'server');

  // This is to be run by phantomjs, not as part of normal package code.
  api.addAssets('phantomRunner.js', 'server');
  api.addAssets('puppeteerRunner.js', 'server');

  api.export('runTests');
});
