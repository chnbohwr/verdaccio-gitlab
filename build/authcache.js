"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.UserData = exports.AuthCache = void 0;

var _crypto = _interopRequireDefault(require("crypto"));

var _nodeCache = _interopRequireDefault(require("node-cache"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

class AuthCache {
  static get DEFAULT_TTL() {
    return 300;
  }

  static _generateKeyHash(username, password) {
    const sha = _crypto.default.createHash('sha256');

    sha.update(JSON.stringify({
      username: username,
      password: password
    }));
    return sha.digest('hex');
  }

  constructor(logger, ttl) {
    _defineProperty(this, "logger", void 0);

    _defineProperty(this, "ttl", void 0);

    _defineProperty(this, "storage", void 0);

    this.logger = logger;
    this.ttl = ttl || AuthCache.DEFAULT_TTL;
    this.storage = new _nodeCache.default({
      stdTTL: this.ttl,
      useClones: false
    });
    this.storage.on('expired', (key, value) => {
      this.logger.trace(`[gitlab] expired key: ${key} with value:`, value);
    });
  }

  findUser(username, password) {
    return this.storage.get(AuthCache._generateKeyHash(username, password));
  }

  storeUser(username, password, userData) {
    return this.storage.set(AuthCache._generateKeyHash(username, password), userData);
  }

}

exports.AuthCache = AuthCache;

class UserData {
  get username() {
    return this._username;
  }

  get groups() {
    return this._groups;
  }

  set groups(groups) {
    this._groups = groups;
  }

  constructor(username, groups) {
    _defineProperty(this, "_username", void 0);

    _defineProperty(this, "_groups", void 0);

    this._username = username;
    this._groups = groups;
  }

}

exports.UserData = UserData;