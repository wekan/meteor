Package.describe({
  summary: "Reactive variable",
  version: '1.0.13-alpha300.17'
});

Package.onUse(function (api) {
  api.export('ReactiveVar');

  api.use('tracker');

  api.addFiles('reactive-var.js');
  api.addAssets('reactive-var.d.ts', 'server');
});
