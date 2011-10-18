
/**
 * @fileoverview The utils for the framework.
 */

(function(util, data, global) {

  var config = data.config;


  /**
   * Extracts the directory portion of a path.
   * dirname('a/b/c.js') ==> 'a/b/'
   * dirname('d.js') ==> './'
   * @see http://jsperf.com/regex-vs-split/2
   */
  function dirname(path) {
    var s = path.match(/.*(?=\/.*$)/);
    return (s ? s[0] : '.') + '/';
  }


  /**
   * Canonicalizes a path.
   * realpath('./a//b/../c') ==> 'a/c'
   */
  function realpath(path) {
    // 'file:///a//b/c' ==> 'file:///a/b/c'
    // 'http://a//b/c' ==> 'http://a/b/c'
    path = path.replace(/([^:\/])\/+/g, '$1\/');

    // 'a/b/c', just return.
    if (path.indexOf('.') === -1) {
      return path;
    }

    var old = path.split('/');
    var ret = [], part, i = 0, len = old.length;

    for (; i < len; i++) {
      part = old[i];
      if (part === '..') {
        if (ret.length === 0) {
          util.error({
            message: 'invalid path: ' + path,
            type: 'error'
          });
        }
        ret.pop();
      }
      else if (part !== '.') {
        ret.push(part);
      }
    }

    return ret.join('/');
  }


  /**
   * Normalizes an url.
   */
  function normalize(url) {
    url = realpath(url);

    // Adds the default '.js' extension except that the url ends with #.
    if (/#$/.test(url)) {
      url = url.slice(0, -1);
    }
    else if (url.indexOf('?') === -1 && !/\.(?:css|js)$/.test(url)) {
      url += '.js';
    }

    return url;
  }


  /**
   * Parses alias in the module id. Only parse the prefix and suffix.
   */
  function parseAlias(id) {
    var alias = config['alias'];
    if (!alias) return id;

    var parts = id.split('/');
    var last = parts.length - 1;
    var parsed = false;

    parse(parts, 0);
    if (!parsed && last) {
      parse(parts, last);
    }

    function parse(parts, i) {
      var part = parts[i];
      if (alias && alias.hasOwnProperty(part)) {
        parts[i] = alias[part];
        parsed = true;
      }
    }

    return parts.join('/');
  }


  /**
   * Maps the module id.
   * @param {string} url The url string.
   * @param {Array=} opt_map The optional map array.
   */
  function parseMap(url, opt_map) {
    // config.map: [[match, replace], ...]
    opt_map = opt_map || config['map'] || [];
    if (!opt_map.length) return url;

    // [match, replace, -1]
    var last = [];

    util.forEach(opt_map, function(rule) {
      if (rule && rule.length > 1) {
        if (rule[2] === -1) {
          last.push([rule[0], rule[1]]);
        }
        else {
          url = url.replace(rule[0], rule[1]);
        }
      }
    });

    if (last.length) {
      url = parseMap(url, last);
    }

    return url;
  }


  /**
   * Gets the host portion from url.
   */
  function getHost(url) {
    return url.replace(/^(\w+:\/\/[^/]*)\/?.*$/, '$1');
  }


  /**
   * Normalizes pathname to start with '/'
   * Ref: https://groups.google.com/forum/#!topic/seajs/9R29Inqk1UU
   */
  function normalizePathname(pathname) {
    if (pathname.charAt(0) !== '/') {
      pathname = '/' + pathname;
    }
    return pathname;
  }


  var loc = global['location'];
  var pageUrl = loc.protocol + '//' + loc.host +
      normalizePathname(loc.pathname);

  // local file in IE: C:\path\to\xx.js
  if (pageUrl.indexOf('\\') !== -1) {
    pageUrl = pageUrl.replace(/\\/g, '/');
  }

  /**
   * Converts id to uri.
   * @param {string} id The module id.
   * @param {string=} opt_refUrl The referenced uri for relative id.
   * @param {boolean=} opt_aliasParsed When set to true, alias has been parsed.
   */
  function id2Uri(id, opt_refUrl, opt_aliasParsed) {
    if (!opt_aliasParsed) {
      id = parseAlias(id);
    }

    opt_refUrl = opt_refUrl || pageUrl;
    var ret;

    // absolute id
    if (isAbsolutePath(id)) {
      ret = id;
    }
    // relative id
    else if (id.indexOf('./') === 0 || id.indexOf('../') === 0) {
      // Converts './a' to 'a', to avoid unnecessary loop in realpath.
      id = id.replace(/^\.\//, '');
      ret = dirname(opt_refUrl) + id;
    }
    // root id
    else if (id.charAt(0) === '/') {
      ret = getHost(opt_refUrl) + id;
    }
    // top-level id
    else {
      ret = getConfigBase() + '/' + id;
    }

    ret = normalize(ret);
    ret = parseMap(ret);

    return ret;
  }


  function getConfigBase() {
    if (!config.base) {
      util.error({
        message: 'the config.base is empty',
        from: 'id2Uri',
        type: 'error'
      });
    }
    return config.base;
  }


  /**
   * Converts ids to uris.
   * @param {Array.<string>} ids The module ids.
   * @param {string=} opt_refUri The referenced uri for relative id.
   */
  function ids2Uris(ids, opt_refUri) {
    return util.map(ids, function(id) {
      return id2Uri(id, opt_refUri);
    });
  }


  var memoizedMods = data.memoizedMods;

  /**
   * Caches mod info to memoizedMods.
   */
  function memoize(id, url, mod) {
    var uri;

    // define('id', [], fn)
    if (id) {
      uri = id2Uri(id, url, true);
    }
    else {
      uri = url;
    }

    mod.id = uri; // change id to absolute path.
    mod.dependencies = ids2Uris(mod.dependencies, uri);
    memoizedMods[uri] = mod;

    // guest module in package
    if (id && url !== uri) {
      var host = memoizedMods[url];
      if (host) {
        augmentPackageHostDeps(host.dependencies, mod.dependencies);
      }
    }
  }

  /**
   * Set mod.ready to true when all the requires of the module is loaded.
   */
  function setReadyState(uris) {
    util.forEach(uris, function(uri) {
      if (memoizedMods[uri]) {
        memoizedMods[uri].ready = true;
      }
    });
  }

  /**
   * Removes the "ready = true" uris from input.
   */
  function getUnReadyUris(uris) {
    return util.filter(uris, function(uri) {
      var mod = memoizedMods[uri];
      return !mod || !mod.ready;
    });
  }

  /**
   * if a -> [b -> [c -> [a, e], d]]
   * call removeMemoizedCyclicUris(c, [a, e])
   * return [e]
   */
  function removeCyclicWaitingUris(uri, deps) {
    return util.filter(deps, function(dep) {
      return !isCyclicWaiting(memoizedMods[dep], uri);
    });
  }

  function isCyclicWaiting(mod, uri) {
    if (!mod || mod.ready) {
      return false;
    }

    var deps = mod.dependencies || [];
    if (deps.length) {
      if (util.indexOf(deps, uri) !== -1) {
        return true;
      } else {
        for (var i = 0; i < deps.length; i++) {
          if (isCyclicWaiting(memoizedMods[deps[i]], uri)) {
            return true;
          }
        }
        return false;
      }
    }
    return false;
  }


  /**
   * For example:
   *  sbuild host.js --combo
   *   define('./host', ['./guest'], ...)
   *   define('./guest', ['jquery'], ...)
   * The jquery is not combined to host.js, so we should add jquery
   * to host.dependencies
   */
  function augmentPackageHostDeps(hostDeps, guestDeps) {
    util.forEach(guestDeps, function(guestDep) {
      if (util.indexOf(hostDeps, guestDep) === -1) {
        hostDeps.push(guestDep);
      }
    });
  }


  /**
   * Determines whether the id is absolute.
   */
  function isAbsolutePath(id) {
    return id.indexOf('://') !== -1 || id.indexOf('//') === 0;
  }


  util.dirname = dirname;

  util.parseAlias = parseAlias;
  util.id2Uri = id2Uri;
  util.ids2Uris = ids2Uris;

  util.memoize = memoize;
  util.setReadyState = setReadyState;
  util.getUnReadyUris = getUnReadyUris;
  util.removeCyclicWaitingUris = removeCyclicWaitingUris;
  util.isAbsolutePath = isAbsolutePath;

  if (config.debug) {
    util.realpath = realpath;
    util.normalize = normalize;
    util.getHost = getHost;
  }

})(seajs._util, seajs._data, this);
