BrowserPolicy._setRunningTest();

var toObject = function(list, values) {
  if (list == null) return {};
  var result = {};
  for (var i = 0, length = list.length; i < length; i++) {
    if (values) {
      result[list[i]] = values[i];
    } else {
      result[list[i][0]] = list[i][1];
    }
  }
  return result;
};

var cspsEqual = function (csp1, csp2) {
  var cspToObj = function (csp) {
    csp = csp.substring(0, csp.length - 1);
    var parts = csp.split("; ").map(function (part) {
      return part.split(" ");
    });
    var keys = parts.map(part => part[0]);
    var values = parts.map((part) => {
      const [head, ...tail] = part;
      return tail;
    });
    values.forEach(function (value) {
      value.sort();
    });

    return toObject(keys, values);
  };

  return EJSON.equals(cspToObj(csp1), cspToObj(csp2));
};

// It's important to call _reset() at the beginning of these tests; otherwise
// the headers left over at the end of the last test run will be used.

Tinytest.addAsync("browser-policy - csp", async function (test) {
  var defaultCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "connect-src * 'self'; img-src data: 'self'; style-src 'self' 'unsafe-inline';"

  await BrowserPolicy.content._reset();
  // Default policy
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), defaultCsp));
  test.isTrue(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Redundant whitelisting (inline scripts already allowed in default policy)
  await BrowserPolicy.content.allowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), defaultCsp));

  // Disallow inline scripts
  await BrowserPolicy.content.disallowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'self'; " +
                        "connect-src * 'self'; img-src data: 'self'; style-src 'self' 'unsafe-inline';"));
  test.isFalse(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Allow eval
  BrowserPolicy.content.allowEval();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), "default-src 'self'; script-src 'self' 'unsafe-eval'; " +
                        "connect-src * 'self'; img-src data: 'self'; style-src 'self' 'unsafe-inline';"));

  // Disallow inline styles
  BrowserPolicy.content.disallowInlineStyles();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), "default-src 'self'; script-src 'self' 'unsafe-eval'; " +
                        "connect-src * 'self'; img-src data: 'self'; style-src 'self';"));

  // Allow data: urls everywhere
  BrowserPolicy.content.allowDataUrlForAll();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self' data:; script-src 'self' 'unsafe-eval' data:; " +
                        "connect-src * data: 'self'; img-src data: 'self'; style-src 'self' data:;"));

  // Disallow everything
  await BrowserPolicy.content.disallowAll();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), "default-src 'none';"));
  test.isFalse(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Put inline scripts back in
  await BrowserPolicy.content.allowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'unsafe-inline';"));
  test.isTrue(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Add 'self' to all content types
  BrowserPolicy.content.allowSameOriginForAll();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'self' 'unsafe-inline';"));
  test.isTrue(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Disallow all content except same-origin scripts
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowScriptSameOrigin();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'self';"));
  test.isFalse(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Starting with all content same origin, disallowScript() and then allow
  // inline scripts. Result should be that that only inline scripts can execute,
  // not same-origin scripts.
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowSameOriginForAll();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(), "default-src 'self';"));
  BrowserPolicy.content.disallowScript();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'none';"));
  test.isFalse(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));
  await BrowserPolicy.content.allowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'unsafe-inline';"));
  test.isTrue(BrowserPolicy.content._keywordAllowed("script-src", "'unsafe-inline'"));

  // Starting with all content same origin, allow inline scripts. (Should result
  // in both same origin and inline scripts allowed.)
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowSameOriginForAll();
  await BrowserPolicy.content.allowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'self' 'unsafe-inline';"));
  await BrowserPolicy.content.disallowInlineScripts();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; script-src 'self';"));

  // Allow same origin for all content, then disallow object entirely.
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowSameOriginForAll();
  BrowserPolicy.content.disallowObject();
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; object-src 'none';"));

  // Allow foo.com; it should allow both http://foo.com and
  // https://foo.com.
  BrowserPolicy.content.allowImageOrigin("foo.com");
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self'; object-src 'none'; " +
                        "img-src 'self' http://foo.com https://foo.com;"));
  // "Disallow all <object>" followed by "allow foo.com for all" results
  // in <object> srcs from foo.com.
  BrowserPolicy.content.allowOriginForAll("foo.com");
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'self' http://foo.com https://foo.com; " +
                        "object-src http://foo.com https://foo.com; " +
                        "img-src 'self' http://foo.com https://foo.com;"));

  // Check that trailing slashes are trimmed from origins.
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowFrameOrigin("https://foo.com/");
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; frame-src https://foo.com;"));
  BrowserPolicy.content.allowObjectOrigin("foo.com//");
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; frame-src https://foo.com; " +
                        "object-src http://foo.com https://foo.com;"));

  // Check that frame-ancestors property is set correctly.
  BrowserPolicy.content.allowFrameAncestorsOrigin("https://foo.com/");
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; frame-src https://foo.com; " +
                        "object-src http://foo.com https://foo.com; " +
                        "frame-ancestors https://foo.com;"));

  // CSP2 options: nonce
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowScriptOrigin('nonce-2gB8y5CrknnK2dgQk');
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'nonce-2gB8y5CrknnK2dgQk';"));

  // CSP2 options: sha256
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowScriptOrigin('sha256-KFQx9ysdKgqbAPoY7');
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'sha256-KFQx9ysdKgqbAPoY7';"));

  // CSP2 options: sha384
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowScriptOrigin('sha384-mChdKgyBF83ewvbTy');
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'sha384-mChdKgyBF83ewvbTy';"));

  // CSP2 options: sha512
  await BrowserPolicy.content.disallowAll();
  BrowserPolicy.content.allowScriptOrigin('sha512-A8x946bPwaak2LToB');
  test.isTrue(cspsEqual(BrowserPolicy.content._constructCsp(),
                        "default-src 'none'; script-src 'sha512-A8x946bPwaak2LToB';"));
});

Tinytest.add("browser-policy - x-frame-options", function (test) {
  BrowserPolicy.framing._reset();
  test.equal(BrowserPolicy.framing._constructXFrameOptions(), "SAMEORIGIN");
  BrowserPolicy.framing.disallow();
  test.equal(BrowserPolicy.framing._constructXFrameOptions(), "DENY");
  BrowserPolicy.framing.allowAll();
  test.equal(BrowserPolicy.framing._constructXFrameOptions(), null);
  BrowserPolicy.framing.restrictToOrigin("foo.com");
  test.equal(BrowserPolicy.framing._constructXFrameOptions(), "ALLOW-FROM foo.com");
  test.throws(function () {
    BrowserPolicy.framing.restrictToOrigin("bar.com");
  });
});

Tinytest.addAsync("browser-policy - X-Content-Type-Options", async function (test) {
  await BrowserPolicy.content._reset();
  test.equal(BrowserPolicy.content._xContentTypeOptions(), "nosniff");
  BrowserPolicy.content.allowContentTypeSniffing();
  test.equal(BrowserPolicy.content._xContentTypeOptions(), undefined);
});
