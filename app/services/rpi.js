import Service, { inject as service } from '@ember/service';
import { later } from '@ember/runloop';
import { htmlSafe, SafeString } from '@ember/string';
const escapeExpression = Ember.Handlebars.Utils.escapeExpression;

import $ from 'jquery'; // TODO: replace need for $.Callbacks

import debug from 'debug';
const log = debug('ember-rpi:RPi-service');
const warn = debug('ember-rpi:RPi-service');
warn.log = console.warn.bind(console);

function makePromise() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { resolve, reject, promise };
}

export default class RPi extends Service {
  @service paperToaster;
  @service websockets;

  socketRef = null;
  _resolve = null;
  _reject = null;
  isOpen = null;

  _messageCallbacks = null;

  init(...args) {
    super.init(...args);
    log('init');

    // Prepare event callbacks
    this._messageCallbacks = $.Callbacks();

    this.reconnect();
  }

  destroy() {
    const socket = this.socketRef;
    socket.off('open', this.onWsOpen);
    socket.off('message', this.onWsMessage);
    socket.off('close', this.onWsClose);
    super.destroy(...arguments);
  }

  onWsOpen() {
    log('onWsOpen');
    later(this, this._resolve, 50); // It seems that `ws` isn't immediately avaiable when this event fires; still needs another event loop iteration or something
  }

  _lastRemoteErrorToast = new Date('1970-01-01');
  onWsMessage(message) {
    const { data } = message;
    let parsed;
    try {
      parsed = JSON.parse(data);
      this._messageCallbacks.fire(parsed);
      if (parsed.name === 'error') {
        warn('Got error message from back-end', parsed);
        const now = new Date();
        const elapsedSeconds = (now.getTime() - this._lastRemoteErrorToast.getTime()) / 1000;
        if (elapsedSeconds > 5) {
          delete parsed.name;
          const errorInfo = parsed.errorMessage || parsed.error;
          this.toastError(`Received error notification from device${errorInfo ? ': ' + errorInfo : '.'}`);
          this._lastRemoteErrorToast = now;
        }
      }
    }
    catch(e) {
      parsed = null;
      log('Caught exception while trying to parse WS message as JSON', e, message);
    }
    log(`onWsMessage:`, parsed);
  }

  _lastCloseErrorMessageTime = new Date('1970-01-01');
  //_isReconnecting = false; // FIXME: Throttle reconnect attempts...make sure they wait for the previous ones to finish
  onWsClose() {
    log('onWsClose');
    const now = new Date();
    const elapsedSeconds = (now.getTime() - this._lastCloseErrorMessageTime.getTime()) / 1000;
    if (elapsedSeconds > 10) {
      this.toastError('There seems to be a problem connecting to the instrument (connection keeps closing)', { duration: 10 * 1000 });
      this._lastCloseErrorMessageTime = now;
    }
    //if (!this._isReconnecting) {
    later(this, this.reconnect, 15 * 1000);
    //this._isReconnecting = true;
    //}
  }

  reconnect() {
    log("Attempting to (re)connect to WebSocket server");
    // Remove old event listeners
    let socket = this.socketRef;
    if (socket) {
      socket.off('close', this.onWsClose);
      socket.off('message', this.onWsMessage);
      socket.off('open', this.onWsOpen);
    }

    // Connect to WebSocket server
    // TODO: This should probably be set in environment
    //const isLocalHost = window.location.hostname.toLowerCase() === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '::1';
    //const wsURI = isLocalHost ? 'wss://jacobq.com/ws' : `wss://${window.location.host}/ws`;
    const wsURI = `wss://${window.location.host}/ws`;
    log(`wsURI=${wsURI}`);

    socket = null;
    try {
      socket = this.websockets.socketFor(wsURI);
      log(`Returned from socketFor(${wsURI})`);
      socket.on('open', this.onWsOpen, this);
      socket.on('message', this.onWsMessage, this);
      socket.on('close', this.onWsClose, this);
      this.isOpen = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
      socket.reconnect();
      log(`Returned from socket.reconnect`);
    } catch (e) {
      warn(e);
      this.toastError('There was a problem establishing communication with the device');
    }
    this.socketRef = socket;
  }

  // TODO: Add timeout support
  async waitForResponse(name) {
    const { resolve, /*reject,*/ promise } = makePromise();
    const cb = (data, ...args) => {
      log('callback fired', data, ...args);
      if (data && data.name === name) {
        this._messageCallbacks.remove(cb);
        resolve(data);
      }
    };
    this._messageCallbacks.add(cb);
    return promise;
  }

  async send(message, retryNumber = 0) {
    message = typeof message === 'string' ? message : JSON.stringify(message);
    const maxRetries = 10;
    await this.isOpen;
    try {
      this.socketRef.send(message);
    } catch(e) {
      log(`Caught exception while trying to send: ${message}`, e);
      this.reconnect();
      if (retryNumber < maxRetries) {
        later(() => this.send(message, retryNumber + 1), 1000);
      }
      else {
        const warningMessage = `Reached maximum # of retries when attempting to send message to WebSocket server: ${message}`;
        warn(warningMessage);
        throw Error(warningMessage);
      }
    }
  }

  async getFile(path: string) {
    log('getFile called', path);
    const promise = this.waitForResponse('getFile');
    await this.send({ command: 'getFile', path });
    log(`getFile sent request`);
    const { base64, error } = await promise;
    log(`getFile got base64 =`, base64, `, error =`, error);
    if (error) {
      this.toastError(`Error retrieving file: ${path}`);
      const exceptionToThrow = Error(`getFile failed`);
      exceptionToThrow.details = error;
      throw exceptionToThrow;
    }
    return base64;
  }

  triggerDownload(name, base64contents, type = "text/plain") {
    const a = document.getElementById('download-anchor');
    // Note: Max URI length is limited by the browser -- typically ~64K...I think Chrome let us get about 5MB of data when we tried...
    //a.href = `data:${type};base64,${base64contents}`;
    a.href = URL.createObjectURL(new Blob([atob(base64contents)], { type }));
    a.download = name;
    a.click();
    this.toastSuccess(`Downloading file: ${name}`, { duration: 1000 });
  }

  _lastToast = null;
  toast(htmlSafeMessage, toastOptions) {
    if (this._lastToast) {
      this.paperToaster.cancelToast(this._lastToast);
    }
    this._lastToast = this.paperToaster.show(htmlSafeMessage, Object.assign({
      duration: 3*1000,
    }, toastOptions));
  }

  toastError(message, options) {
    return this.toast(htmlSafe(`<h3>${escapeExpression(message)}</h3>`), Object.assign({
      toastClass: 'error-toast'
    }, options));
  }

  toastSuccess(message, options) {
    return this.toast(htmlSafe(`<h3>${escapeExpression(message)}</h3>`), Object.assign({}, options));
  }
}
