"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _commonsApi = require("@verdaccio/commons-api");

var _gitlab = _interopRequireDefault(require("gitlab"));

var _authcache = require("./authcache");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const ACCESS_LEVEL_MAPPING = {
  $guest: 10,
  $reporter: 20,
  $developer: 30,
  $maintainer: 40,
  $owner: 50
}; // List of verdaccio builtin levels that map to anonymous access

const BUILTIN_ACCESS_LEVEL_ANONYMOUS = ['$anonymous', '$all']; // Level to apply on 'allow_access' calls when a package definition does not define one

const DEFAULT_ALLOW_ACCESS_LEVEL = ['$all'];

class VerdaccioGitLab {
  // @ts-ignore
  constructor(config, options) {
    _defineProperty(this, "options", void 0);

    _defineProperty(this, "config", void 0);

    _defineProperty(this, "authCache", void 0);

    _defineProperty(this, "logger", void 0);

    _defineProperty(this, "publishLevel", void 0);

    this.logger = options.logger;
    this.config = config;
    this.options = options;
    this.logger.info(`[gitlab] url: ${this.config.url}`);

    if ((this.config.authCache || {}).enabled === false) {
      this.logger.info('[gitlab] auth cache disabled');
    } else {
      const ttl = (this.config.authCache || {}).ttl || _authcache.AuthCache.DEFAULT_TTL;
      this.authCache = new _authcache.AuthCache(this.logger, ttl);
      this.logger.info(`[gitlab] initialized auth cache with ttl: ${ttl} seconds`);
    }

    this.publishLevel = '$maintainer';

    if (this.config.publish) {
      this.publishLevel = this.config.publish;
    }

    if (!Object.keys(ACCESS_LEVEL_MAPPING).includes(this.publishLevel)) {
      throw Error(`[gitlab] invalid publish access level configuration: ${this.publishLevel}`);
    }

    this.logger.info(`[gitlab] publish control level: ${this.publishLevel}`);
  }

  authenticate(user, password, cb) {
    this.logger.trace(`[gitlab] authenticate called for user: ${user}`); // Try to find the user groups in the cache

    const cachedUserGroups = this._getCachedUserGroups(user, password);

    if (cachedUserGroups) {
      // @ts-ignore
      this.logger.debug(`[gitlab] user: ${user} found in cache, authenticated with groups:`, cachedUserGroups);
      return cb(null, cachedUserGroups.publish);
    } // Not found in cache, query gitlab


    this.logger.trace(`[gitlab] user: ${user} not found in cache`);
    const GitlabAPI = new _gitlab.default({
      url: this.config.url,
      token: password
    });
    GitlabAPI.Users.current().then(response => {
      if (user.toLowerCase() !== response.username.toLowerCase()) {
        return cb((0, _commonsApi.getUnauthorized)('wrong gitlab username'));
      }

      const publishLevelId = ACCESS_LEVEL_MAPPING[this.publishLevel]; // Set the groups of an authenticated user, in normal mode:
      // - for access, depending on the package settings in verdaccio
      // - for publish, the logged in user id and all the groups they can reach as configured with access level `$auth.gitlab.publish`

      const gitlabPublishQueryParams = {
        min_access_level: publishLevelId
      }; // @ts-ignore

      this.logger.trace('[gitlab] querying gitlab user groups with params:', gitlabPublishQueryParams);
      const groupsPromise = GitlabAPI.Groups.all(gitlabPublishQueryParams).then(groups => {
        return groups.filter(group => group.path === group.full_path).map(group => group.path);
      });
      const projectsPromise = GitlabAPI.Projects.all(gitlabPublishQueryParams).then(projects => {
        return projects.map(project => project.path_with_namespace);
      });
      Promise.all([groupsPromise, projectsPromise]).then(([groups, projectGroups]) => {
        const realGroups = [user, ...groups, ...projectGroups];

        this._setCachedUserGroups(user, password, {
          publish: realGroups
        });

        this.logger.info(`[gitlab] user: ${user} successfully authenticated`); // @ts-ignore

        this.logger.debug(`[gitlab] user: ${user}, with groups:`, realGroups);
        return cb(null, realGroups);
      }).catch(error => {
        this.logger.error(`[gitlab] user: ${user} error querying gitlab: ${error}`);
        return cb((0, _commonsApi.getUnauthorized)('error authenticating user'));
      });
    }).catch(error => {
      this.logger.error(`[gitlab] user: ${user} error querying gitlab user data: ${error.message || {}}`);
      return cb((0, _commonsApi.getUnauthorized)('error authenticating user'));
    });
  }

  adduser(user, password, cb) {
    this.logger.trace(`[gitlab] adduser called for user: ${user}`);
    return cb(null, true);
  }

  changePassword(user, password, newPassword, cb) {
    this.logger.trace(`[gitlab] changePassword called for user: ${user}`);
    return cb((0, _commonsApi.getInternalError)('You are using verdaccio-gitlab integration. Please change your password in gitlab'));
  }

  allow_access(user, _package, cb) {
    if (!_package.gitlab) return cb(null, false);
    const packageAccess = _package.access && _package.access.length > 0 ? _package.access : DEFAULT_ALLOW_ACCESS_LEVEL;

    if (user.name !== undefined) {
      // successfully authenticated
      this.logger.debug(`[gitlab] allow user: ${user.name} authenticated access to package: ${_package.name}`);
      return cb(null, true);
    } else {
      // unauthenticated
      if (BUILTIN_ACCESS_LEVEL_ANONYMOUS.some(level => packageAccess.includes(level))) {
        this.logger.debug(`[gitlab] allow anonymous access to package: ${_package.name}`);
        return cb(null, true);
      } else {
        this.logger.debug(`[gitlab] deny access to package: ${_package.name}`);
        return cb((0, _commonsApi.getUnauthorized)('access denied, user not authenticated and anonymous access disabled'));
      }
    }
  }

  allow_publish(user, _package, cb) {
    if (!_package.gitlab) return cb(null, false);
    const packageScopePermit = false;
    let packagePermit = false; // Only allow to publish packages when:
    //  - the package has exactly the same name as one of the user groups, or
    //  - the package scope is the same as one of the user groups

    for (const real_group of user.real_groups) {
      // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
      this.logger.trace(`[gitlab] publish: checking group: ${real_group} for user: ${user.name || ''} and package: ${_package.name}`);

      if (this._matchGroupWithPackage(real_group, _package.name)) {
        packagePermit = true;
        break;
      }
    }

    if (packagePermit || packageScopePermit) {
      const perm = packagePermit ? 'package-name' : 'package-scope';
      this.logger.debug(`[gitlab] user: ${user.name || ''} allowed to publish package: ${_package.name} based on ${perm}`);
      return cb(null, true);
    } else {
      this.logger.debug(`[gitlab] user: ${user.name || ''} denied from publishing package: ${_package.name}`); // @ts-ignore

      const missingPerm = _package.name.indexOf('@') === 0 ? 'package-scope' : 'package-name';
      return cb((0, _commonsApi.getForbidden)(`must have required permissions: ${this.publishLevel || ''} at ${missingPerm}`));
    }
  }

  _matchGroupWithPackage(real_group, package_name) {
    if (real_group === package_name) {
      return true;
    }

    if (package_name.indexOf('@') === 0) {
      const split_real_group = real_group.split('/');
      const split_package_name = package_name.slice(1).split('/');

      if (split_real_group.length > split_package_name.length) {
        return false;
      }

      for (let i = 0; i < split_real_group.length; i += 1) {
        if (split_real_group[i] !== split_package_name[i]) {
          return false;
        }
      }

      return true;
    }

    return false;
  }

  _getCachedUserGroups(username, password) {
    if (!this.authCache) {
      return null;
    }

    const userData = this.authCache.findUser(username, password);
    return (userData || {}).groups || null;
  }

  _setCachedUserGroups(username, password, groups) {
    if (!this.authCache) {
      return false;
    }

    this.logger.debug(`[gitlab] saving data in cache for user: ${username}`);
    return this.authCache.storeUser(username, password, new _authcache.UserData(username, groups));
  }

}

exports.default = VerdaccioGitLab;