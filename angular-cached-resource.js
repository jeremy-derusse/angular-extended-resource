'use strict';

angular.module('cResource', ['ngResource'])
  .value('$cResourceConfig', function() {
    return {
      prefix: '',
      ttl: 864000,
    };
  })
  .provider('$cResource', function() {
    var provider = this;

    this.defaults = {
      actions: {
        'get':    {method:'GET', $cache:true},
        'query':  {method:'GET', $cache:{key:true, split: {'': true}}, isArray:true},
      }
    };

    this.$get = ['$window', '$interval', '$resource', '$cResourceConfig', function($window, $interval, $resource, $cResourceConfig) {
      /**
       * Manipulate template and placeHolder
       *
       * @see ngResource Route
       */
      function TemplateEngine() {
      }

      /**
       * @see ngResource Route
       *
       * We need our custom method because encodeURIComponent is too aggressive and doesn't follow
       * http://www.ietf.org/rfc/rfc3986.txt with regards to the character set (pchar) allowed in path
       * segments:
       *    segment       = *pchar
       *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
       *    pct-encoded   = "%" HEXDIG HEXDIG
       *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
       *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
       *                     / "*" / "+" / "," / ";" / "="
       */
      TemplateEngine.prototype.encodeUriSegment = function encodeUriSegment(val) {
        return this.encodeUriQuery(val, true).
          replace(/%26/gi, '&').
          replace(/%3D/gi, '=').
          replace(/%2B/gi, '+');
      };

      /**
       * @see ngResource Route
       *
       * This method is intended for encoding *key* or *value* parts of query component. We need a
       * custom method because encodeURIComponent is too aggressive and encodes stuff that doesn't
       * have to be encoded per http://tools.ietf.org/html/rfc3986:
       *    query       = *( pchar / "/" / "?" )
       *    pchar         = unreserved / pct-encoded / sub-delims / ":" / "@"
       *    unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
       *    pct-encoded   = "%" HEXDIG HEXDIG
       *    sub-delims    = "!" / "$" / "&" / "'" / "(" / ")"
       *                     / "*" / "+" / "," / ";" / "="
       */
      TemplateEngine.prototype.encodeUriQuery = function encodeUriQuery(val, pctEncodeSpaces) {
        return encodeURIComponent(val).
          replace(/%40/gi, '@').
          replace(/%3A/gi, ':').
          replace(/%24/g, '$').
          replace(/%2C/gi, ',').
          replace(/%20/g, (pctEncodeSpaces ? '%20' : '+'));
      };

      /**
       * Replace placeHolder from a template
       *
       * @param string template Template to render
       * @param object params   List of params
       *
       * @return string
       */
      TemplateEngine.prototype.render = function render(template, params) {
        var _this = this,
            url = template,
            val,
            encodedVal;

        var urlParams = {};
        angular.forEach(url.split(/\W/), function(param){
          if (param === 'hasOwnProperty') {
            throw angular.$$minErr('$cResource')('badname', 'hasOwnProperty is not a valid parameter name.');
          }
          if (!(/^\\d+$/.test(param)) && param &&
               (new RegExp('(^|[^\\\\]):' + param + '(\\W|$)').test(url))) {
            urlParams[param] = true;
          }
        });
        url = url.replace(/\\:/g, ':');

        params = params || {};
        angular.forEach(urlParams, function(_, urlParam){
          val = params.hasOwnProperty(urlParam) ? params[urlParam] : undefined;
          if (angular.isDefined(val) && val !== null) {
            encodedVal = _this.encodeUriSegment(val);
            url = url.replace(new RegExp(':' + urlParam + '(\\W|$)', 'g'), function(match, p1) {
              return encodedVal + p1;
            });
          } else {
            url = url.replace(new RegExp('(\/?):' + urlParam + '(\\W|$)', 'g'), function(match,
                leadingSlashes, tail) {
              if (tail.charAt(0) === '/') {
                return tail;
              } else {
                return leadingSlashes + tail;
              }
            });
          }
        });

        // strip trailing slashes and set the url
        url = url.replace(/\/+$/, '') || '/';
        // then replace collapse `/.` if found in the last URL path segment before the query
        // E.g. `http://url.com/id./format?q=x` becomes `http://url.com/id.format?q=x`
        url = url.replace(/\/\.(?=\w+($|\?))/, '.');
        // replace escaped `/\.` with `/.`
        return url.replace(/\/\\\./, '/.');
      };

      /**
       * Store a retreives data from cache
       *
       * @param integer ttl Delays before purging data from cache
       */
      function Cache(ttl) {
        this.ttl = ttl;
      }

      /**
       * Store a data into cache
       *
       * @param string key
       * @param mixed  value
       */
      Cache.prototype.put = function put(key, value) {
        value = angular.copy(value);
        delete value.$promise;
        delete value.$resolved;
        delete value.$cache;
        var o = [
              new Date().getTime(),
              value
            ],
            encoded = JSON.stringify(o);

        if (encoded  === undefined) {
          delete $window.localStorage[key];
        } else {
          $window.localStorage[key] = encoded;
        }
      };

      /**
       * Retreives a data from cache
       *
       * @param string key
       */
      Cache.prototype.get = function get(key) {
        var data = $window.localStorage[key];
        if (data === undefined || data === 'undefined') {
          return undefined;
        }
        var s = JSON.parse(data);
        var value = s[1];
        value.$cache = {updated: s[0], stale: true};
        return value;
      };

      Cache.prototype.gc = function gc() {
        var _this = this,
            now = new Date().getTime();
        angular.forEach($window.localStorage, function(data, index) {
          if (data !== undefined && data !== 'undefined') {
            var s = JSON.parse(data);
            if (angular.isArray(s) && s.length > 1) {
              if (s[0] + _this.ttl < now) {
                delete $window.localStorage[index];
              }
            }
          }
        });
      };

      /**
       * Provides tool for exploring an object
       */
      function PathExplorer() {
      }

      PathExplorer.MEMBER_NAME_REGEX = /^(\.[a-zA-Z_$][0-9a-zA-Z_$]*)+$/;

      /**
       * Determine if the path is valid or not
       *
       * @param string path
       *
       * @return Boolean
       */
      PathExplorer.prototype.isValidDottedPath = function isValidDottedPath(path) {
        return (path !== null && path !== '' && path !== 'hasOwnProperty' &&
            PathExplorer.MEMBER_NAME_REGEX.test('.' + path));
      };

      /**
       * Retreives an elements by the property path
       *
       * @param object obj Object to lookup
       * @param string path
       *
       * @return mixed
       */
      PathExplorer.prototype.getElement = function getElement(obj, path) {
        if (!this.isValidDottedPath(path)) {
          throw angular.$$minErr('badmember', 'Dotted member path "@{0}" is invalid.', path);
        }
        var keys = path.split('.');
        for (var i = 0, ii = keys.length; i < ii && obj !== undefined; i++) {
          var key = keys[i];
          obj = (obj !== null) ? obj[key] : undefined;
        }
        return obj;
      };

      /**
       * Apply a callback to an element of an object
       *
       * @param mixed    object   Object to modify
       * @param string   path     Path to the attributte to modify
       * @param Function callback Function to apply to the object
       *
       * @return Edited object
       */
      PathExplorer.prototype.changeElement = function changeElement(object, path, callback) {
        var _this = this;
        if (path === '') {
          if (angular.isArray(object)) {
            var objectCopy = angular.copy(object);
            object.length = 0;
            angular.forEach(objectCopy, function(element) {
              object.push(callback(element));
            });

            return object;
          } else {
            return callback(object);
          }
        } else {
          if (!this.isValidDottedPath(path)) {
            throw angular.$$minErr('$cResource')('badmember', 'Dotted member path "@{0}" is invalid.', path);
          }
          var keys = path.split('.');
          var key = keys.shift();
          var subPath = keys.join('.');

          angular.forEach(angular.isArray(object) ? object: [object], function(element) {
            if (angular.isDefined(element[key])) {
              element[key] = _this.changeElement(element[key], subPath, callback);
            }
          });

          return object;
        }
      };

      /**
       * Resource cachen engine
       *
       * @param string template      Default cacheKey template
       * @param object paramDefaults Default cacheKey placeholders
       * @param object cacheSettings Cache settings
       */
      function Engine(template, paramDefaults, cacheSettings) {
        this.enabled = true;
        this.template = template;
        this.paramDefaults = paramDefaults || {};
        this.init(cacheSettings);
      }

      /**
       * Initialize the engine
       *
       * @param object cacheSettings
       */
      Engine.prototype.init = function init(cacheSettings) {
        if (!angular.isObject(cacheSettings)) {
          return this.init({key: cacheSettings});
        }

        if (cacheSettings.key === false) {
          this.enabled = false;
        } else if (cacheSettings.key === true) {
          // do nothing
        } else if (angular.isString(cacheSettings.key)) {
          this.template = cacheSettings.key;
        } else {
          throw angular.$$minErr('$cResource')('badmember', 'cacheKey property is not valid.');
        }

        if (angular.isDefined(cacheSettings.split) && !angular.isObject(cacheSettings.split)) {
          throw angular.$$minErr('$cResource')('badmember', 'cacheSplit property must be an object.');
        }

        if (angular.isDefined(cacheSettings.params)) {
          angular.extend(this.paramDefaults, cacheSettings.params);
        }

        this.splitProperties = [];
        this.splitConfigs = cacheSettings.split || {};
        var _this = this;
        angular.forEach(this.splitConfigs, function(config, property) {
          _this.splitProperties.push(property);
        });
      };

      /**
       * Extracts params from an object
       *
       * @param object  data        Object containing data
       * @param object  params      List of parameters to extract
       * @param boolean removeLinks If true, links ('@id') without correspondaces, will be let as it ('@id').Otherwise, the params will contains undefined
       *
       * @return object
       */
      Engine.prototype.extractParams = function extractParams(data, params, removeLinks) {
        if (removeLinks === undefined) {
          removeLinks = true;
        }

        var ids = {};
        params = angular.extend({}, params);
        angular.forEach(params, function(value, key){
          if (angular.isFunction(value)) { value = value(); }
          if (value && value.charAt && value.charAt(0) === '@') {
            var linked = pathExplorer.getElement(data, value.substr(1));
            ids[key] = linked === undefined && !removeLinks ? value : linked;
          } else {
            ids[key] = value;
          }
        });
        return ids;
      };

      /**
       * Retreive list of params for template
       *
       * @param object  callParams  List of parameters passed in original resource's call
       * @param object  callData    Data passed in original resource's call
       * @param boolean removeLinks @see extractParams
       * @return object
       */
      Engine.prototype.getTemplateParams = function getTemplateParams(callParams, callData, removeLinks) {
        return angular.extend({}, this.extractParams(callData, this.paramDefaults, removeLinks), callParams);
      };

      /**
       * Retreives the cache key
       *
       * @param object templateParams List of parameters to apply in template
       *
       * @return string
       */
      Engine.prototype.getKey = function getKey(templateParams) {
        return $cResourceConfig.prefix + templateEngine.render(this.template, templateParams);
      };

      /**
       * Split a resource
       *
       * @param object resource       Resource to split
       * @param object templateParams List of resource's templateParams
       */
      Engine.prototype.splitResource = function splitResource(resource, templateParams) {
        var _this = this;
        angular.forEach(this.splitProperties.sort().reverse(), function(propertyPath) {
          var engine = new Engine(_this.template + propertyPath, templateParams, _this.splitConfigs[propertyPath]);
          pathExplorer.changeElement(resource, propertyPath, function(element) {
            return '#' + engine.store(element, {}, element);
          });
        });
      };

      /**
       * Store a resource in cache
       *
       * @param object resource   Ressource to store
       * @param object callParams List of parameters passed in original resource's
       */
      Engine.prototype.store = function store(resource, callParams) {
        if (!this.enabled) {
          return;
        }

        resource = angular.copy(resource);

        if (this.splitProperties.length) {
          this.splitResource(resource, this.getTemplateParams(callParams, resource, false));
        }
        var key = this.getKey(this.getTemplateParams(callParams, resource));
        cache.put(key, resource);

        return key;
      };

      /**
       * Join a splitted resource
       *
       * @param object resource Ressource to join
       */
      Engine.prototype.joinResource = function joinResource(resource) {
        var _this = this;
        angular.forEach(this.splitProperties.sort(), function(propertyPath) {
          var engine = new Engine(null, {}, _this.splitConfigs[propertyPath]);
          pathExplorer.changeElement(resource, propertyPath, function(element) {
            if (element[0] === '#') {
              var restored = cache.get(element.substr(1));
              engine.joinResource(restored);
              return restored;
            } else {
              return element;
            }
          });
        });
      };

      /**
       * Retreive a ressource from cache
       *
       * @param object callParams List of parameters passed in original resource's call
       * @param object callData   Data passed in original resource's call
       *
       * @return mixed
       */
      Engine.prototype.fetch = function fetch(callParams, callData) {
        if (!this.enabled) {
          return;
        }

        var key = this.getKey(this.getTemplateParams(callParams, callData)),
            resource = cache.get(key);

        if (!angular.isDefined(resource)) {
          return resource;
        }

        if (this.splitProperties.length) {
          this.joinResource(resource);
        }

        return resource;
      };

      var pathExplorer = new PathExplorer(),
          templateEngine = new TemplateEngine(),
          cache = new Cache($cResourceConfig.ttl);

      $interval(function() {cache.gc();}, 30000);
      cache.gc();

      var cacheWrapper = function cacheWrapper(call, url, paramDefaults, action, cacheSettings) {
        var hasBody = function hasBody() {
          return /^(POST|PUT|PATCH)$/i.test(action.method);
        };

        /**
         * Parse call's arguments to determine which is params, data, success and error
         */
        var parseArguments = function parseArguments(a1, a2, a3, a4) {
          var params = {}, data, success, error;
          /* jshint -W086 */ /* (purposefully fall through case statements) */
          switch(arguments.length) {
          case 4:
            error = a4;
            success = a3;
            //fallthrough
          case 3:
          case 2:
            if (angular.isFunction(a2)) {
              if (angular.isFunction(a1)) {
                success = a1;
                error = a2;
                break;
              }
              success = a2;
              error = a3;
              //fallthrough
            } else {
              params = a1;
              data = a2;
              success = a3;
              break;
            }
          case 1:
            if (angular.isFunction(a1)) {
              success = a1;
            }
            else if (hasBody()) {
              data = a1;
            }
            else {
              params = a1;
            }
            break;
          case 0: break;
          default:
            throw angular.$$minErr('$cResource')('badargs',
              'Expected up to 4 arguments [params, data, success, error], got {0} arguments',
              arguments.length);
          }
          return {
            params: params,
            data: data,
            success: success,
            error: error,
          };
        };
        var engine = new Engine(action.url || url, angular.extend({}, paramDefaults, action.params), cacheSettings);

        return function () {
          var response = call.apply(this, arguments);
          var parsedArguments = parseArguments.apply(this, arguments);

          var stored = engine.fetch(parsedArguments.params, parsedArguments.data);
          if (angular.isDefined(stored)) {
            angular.extend(response, stored);
            response.$cache = stored.$cache;
          }

          response.$promise.then(function() {
            response.$cache = response.$cache || {updated: new Date().getTime()};
            response.$cache.stale = false;
            engine.store(response, parsedArguments.params);
          });

          return response;
        };
      };

      return function(url, paramDefaults, actions, options) {
        actions = angular.extend({}, provider.defaults.actions, actions);
        var resource = $resource(url, paramDefaults, actions, options);

        angular.forEach(actions, function(action, name) {
          if (angular.isDefined(action.$cache) && action.$cache !== false) {
            resource[name] = cacheWrapper(resource[name], url, paramDefaults, action, action.$cache);
          }
        });

        return resource;
      };
    }];
  });
