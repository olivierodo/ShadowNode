'use strict';

var util = require('util');
var URL = require('url');
var net = require('net');
var EventEmitter = require('events').EventEmitter;

/*eslint-disable */
var MQTT_CONNECT = 1;
var MQTT_CONNACK = 2;
var MQTT_PUBLISH = 3;
var MQTT_PUBACK = 4;
var MQTT_PUBREC = 5;
var MQTT_PUBREL = 6;
var MQTT_PUBCOMP = 7;
var MQTT_SUBSCRIBE = 8;
var MQTT_SUBACK = 9;
var MQTT_UNSUBSCRIBE = 10;
var MQTT_UNSUBACK = 11;
var MQTT_PINGREQ = 12;
var MQTT_PINGRESP = 13;
var MQTT_DISCONNECT = 14;
/* eslint-enable */

function noop() {}

/**
 * @class MqttClient
 * @param {String} endpoint
 * @param {Object} options
 */
function MqttClient(endpoint, options) {
  EventEmitter.call(this);
  var obj = URL.parse(endpoint);
  this._host = obj.hostname;
  this._port = Number(obj.port) || 8883;
  this._protocol = obj.protocol;
  this._options = Object.assign({
    username: null,
    password: null,
    clientId: 'mqttjs_' + Math.random().toString(16).substr(2, 8),
    will: null,
    keepalive: 60,
    reconnectPeriod: 5000,
    connectTimeout: 30 * 1000,
    resubscribe: true,
    protocolId: 'MQTT',
    protocolVersion: 4,
    pingReqTimeout: 10 * 1000,
  }, options);

  // handle `options.will.payload` to be a Buffer
  if (this._options.will && this._options.will.payload) {
    var willMessage = this._options.will.payload;
    if (!Buffer.isBuffer(willMessage)) {
      this._options.will.payload = new Buffer(willMessage || '');
    }
  }
  this._isSocketConnected = false;
  this._isConnected = false;
  this._reconnecting = false;
  this._reconnectingTimer = null;
  this._lastConnectTime = 0;
  this._msgId = 0;
  this._keepAliveTimer = null;
  this._keepAliveTimeout = null;
  this._handle = new native.MqttHandle(this._options);
  Object.defineProperty(this, 'connected', {
    get: function() {
      return this._isConnected;
    },
  });

  Object.defineProperty(this, 'reconnecting', {
    get: function() {
      return this._reconnecting;
    },
  });

}
util.inherits(MqttClient, EventEmitter);

/**
 * @method connect
 */
MqttClient.prototype.connect = function() {
  var tls;
  var opts = Object.assign({
    port: this._port,
    host: this._host,
  }, this._options);
  if (this._protocol === 'mqtts:') {
    tls = require('tls');
    this._socket = tls.connect(opts, this._onconnect.bind(this));
  } else {
    this._socket = net.connect(opts, this._onconnect.bind(this));
  }
  this._socket.on('data', this._ondata.bind(this));
  this._socket.once('error', this._onerror.bind(this));
  this._socket.once('end', this._onend.bind(this));
  this._lastConnectTime = Date.now();
  this._lastChunk = null;
  var self = this
  setTimeout(() => {
    if (!this._isConnected) {
      this.emit('timeout');
      this._ondisconnect();
    }
  }, self._options.connectTimeout);
  return this;
};

/**
 * @method _onconnect
 */
MqttClient.prototype._onconnect = function() {
  this._isSocketConnected = true;
  var buf;
  try {
    buf = this._handle._getConnect();
  } catch (err) {
    this.disconnect(err);
    return;
  }
  this._write(buf);
};

MqttClient.prototype._onerror = function(err) {
  this.emit('error', err);
  this._ondisconnect();
};

MqttClient.prototype._onend = function() {
  this._clearKeepAlive();
  this._ondisconnect();
};

MqttClient.prototype._ondisconnect = function() {
  this._isSocketConnected = false;
  if (this._isConnected) {
    this._isConnected = false;
    this.emit('offline');
  }
  this.emit('close');
  this.reconnect();
};

MqttClient.prototype._ondata = function(chunk) {
  // one packet in multi chunks
  if (this._lastChunk) {
    chunk = Buffer.concat([this._lastChunk, chunk]);
    this._lastChunk = null;
  }
  var res;
  try {
    res = this._handle._readPacket(chunk);
  } catch (err) {
    this.disconnect(err);
    return;
  }
  this.emit('packetreceive');

  if (res.type === MQTT_CONNACK) {
    this._isConnected = true;
    if (this._reconnecting) {
      clearTimeout(this._reconnectingTimer);
      this._reconnecting = false;
      this.emit('reconnect');
    } else {
      this.emit('connect');
    }
    this._keepAlive();
  } else if (res.type === MQTT_PUBLISH) {
    var msg;
    try {
      msg = this._handle._deserialize(chunk);
    } catch (err) {
      this.disconnect(err);
      return;
    }
    if (msg.payloadMissingSize > 0) {
      this._lastChunk = chunk;
    } else {
      this.emit('message', msg.topic, msg.payload);
      if (msg.qos > 0) {
        // send publish ack
        try {
          var ack = this._handle._getAck(msg.id, msg.qos);
          this._write(ack);
        } catch (err) {
          this.disconnect(err);
          return;
        }
      }
      // multi packets in one chunk
      if (msg.payloadMissingSize < 0) {
        var end = chunk.byteLength;
        var start = end + msg.payloadMissingSize;
        var leftChunk = chunk.slice(start, end);
        this._ondata(leftChunk);
      }
    }
  } else if (res.type === MQTT_PINGRESP) {
    this._onKeepAlive();
  } else {
    // FIXME handle other message type
    this.emit('unhandledMessage', res);
  }
};

/**
 * @method _write
 * @param {Buffer} buffer
 * @param {Function} callback
 */
MqttClient.prototype._write = function(buffer, callback) {
  var self = this;
  callback = callback || noop;
  if (!self._isSocketConnected) {
    callback(new Error('mqtt is disconnected'));
    return;
  }
  self._socket.write(buffer, function() {
    self.emit('packetsend');
    callback();
  });
};

/**
 * @method _keepAlive
 */
MqttClient.prototype._keepAlive = function() {
  var self = this;
  if (self._options.keepalive === 0) {
    // set to 0 to disable
    return;
  }
  self._keepAliveTimer = setTimeout(function() {
    try {
      var buf = self._handle._getPingReq();
      self._write(buf);
    } catch (err) {
      err.message = 'Keepalive Write Error:' + err.message;
      self.disconnect(err);
      return;
    }
    self._keepAliveTimeout = setTimeout(function() {
      self.disconnect(new Error('keepalive timeout'));
    }, self._options.pingReqTimeout);
  }, self._options.keepalive * 1000);
};

MqttClient.prototype._onKeepAlive = function() {
  clearTimeout(this._keepAliveTimeout);
  this._keepAlive();
};

MqttClient.prototype._clearKeepAlive = function() {
  clearTimeout(this._keepAliveTimer);
  clearTimeout(this._keepAliveTimeout);
  this._keepAliveTimer = null;
  this._keepAliveTimeout = null;
};

MqttClient.prototype.disconnect = function(err) {
  if (err) {
    this.emit('error', err);
  }
  if (!this._isConnected) {
    return;
  }

  this._clearKeepAlive();
  clearTimeout(this._reconnectingTimer);
  try {
    var buf = this._handle._getDisconnect();
    this._write(buf);
  } catch (err) {
    this.emit('error', err);
  }
  this._socket.end();
};

/**
 * @method publish
 * @param {String} topic
 * @param {String} payload
 * @param {Object} options
 * @param {Function} callback
 */
MqttClient.prototype.publish = function(topic, payload, options, callback) {
  callback = callback || noop;
  if (!Buffer.isBuffer(payload)) {
    payload = new Buffer(payload);
  }
  try {
    var buf = this._handle._getPublish(topic, {
      id: this._msgId++,
      qos: (options && options.qos) || 0,
      dup: (options && options.dup) || false,
      retain: (options && options.retain) || false,
      payload: payload,
    });
    this._write(buf, callback);
  } catch (err) {
    callback(err);
  }
};

/**
 * @method subscribe
 * @param {String} topic
 * @param {Object} options
 * @param {Function} callback
 */
MqttClient.prototype.subscribe = function(topic, options, callback) {
  if (!Array.isArray(topic))
    topic = [topic];
  if (typeof options === 'function') {
    callback = options;
    options = { qos: 0 };
  } else {
    callback = callback || noop;
  }
  try {
    var buf = this._handle._getSubscribe(topic, {
      id: this._msgId++,
      qos: (options && options.qos) || 0,
    });
    this._write(buf, callback);
  } catch (err) {
    callback(err);
  }
};

/**
 * @method unsubscribe
 * @param {String} topic
 * @param {Function} callback
 */
MqttClient.prototype.unsubscribe = function(topic, callback) {
  callback = callback || noop;
  if (!Array.isArray(topic)) {
    topic = [topic];
  }
  var buf;
  // TODO don't use try catch
  try {
    buf = this._handle._getUnsubscribe(topic, {
      id: this._msgId++,
    });
  } catch (err) {
    callback(err);
    return;
  }
  this._write(buf, callback);
};

/**
 * @method reconnect
 */
MqttClient.prototype.reconnect = function() {
  if (this._reconnecting) {
    return;
  }
  var reconnectPeriod = this._options.reconnectPeriod;
  if (reconnectPeriod < 0) {
    return;
  }
  this.disconnect();
  var t = this._lastConnectTime + reconnectPeriod - Date.now();
  if (t < 1) {
    this.connect();
  } else {
    setTimeout(this.connect.bind(this), t);
  }
};

/**
 * @method getLastMessageId
 */
MqttClient.prototype.getLastMessageId = function() {
  return this._msgId;
};

function connect(endpoint, options) {
  var client = new MqttClient(endpoint, options);
  return client.connect();
}

exports.connect = connect;
