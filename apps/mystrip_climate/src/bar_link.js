/**
 * bar_link - Climate Strip's line to the Climate Bar service
 * (services/mystrip_bar), over /run/mystrip-bar/bar.sock: one JSON object
 * per line each way (the service's header lists them). Connects again every
 * few seconds while the service is not there, so either can start first.
 *
 *   const link = new BarLink(log);
 *   link.on('tap', (item) => ...);       // 'dr' | 'ps' | 'wheel'
 *   link.on('status', (s) => ...);       // the bar's state; null while not connected
 *   link.send({ car: {...} });
 *   link.start();
 *
 * Node 8 compatible.
 */
'use strict';
const EventEmitter = require('events');
const net = require('net');

const SOCKET = '/run/mystrip-bar/bar.sock';
const RETRY_MS = 5000;

class BarLink extends EventEmitter {
    constructor(log, socket) {
        super();
        this.log = log;
        this.socket = socket || SOCKET;
        this.sock = null;
        this.connected = false;
        this.status = null;
        this.last = {};               // the last message of each kind, sent again on connecting
        this.closed = false;
        this.missingLogged = false;
    }

    start() {
        if (this.closed || this.sock) {
            return;
        }
        const s = net.createConnection(this.socket);
        let buf = '';
        this.sock = s;
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.connected = true;
            this.missingLogged = false;
            this.log.info(`bar: connected`);
            Object.keys(this.last).forEach((k) => this._write(this.last[k]));
        });
        s.on('data', (d) => {
            buf += d;
            let at;
            while ((at = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, at);
                buf = buf.slice(at + 1);
                let m = null;
                try {
                    m = JSON.parse(line);
                } catch (e) {
                    m = null;
                }
                if (m && typeof m.tap === 'string') {
                    this.emit('tap', m.tap);
                } else if (m && m.status && typeof m.status === 'object') {
                    this.status = m.status;
                    this.emit('status', m.status);
                }
            }
            if (buf.length > 65536) {
                buf = '';
            }
        });
        s.on('error', (e) => {
            if (!this.missingLogged) {
                this.missingLogged = true;
                this.log.info(`bar: ${e.message}`);
            }
        });
        s.on('close', () => {
            const was = this.connected;
            this.sock = null;
            this.connected = false;
            if (was) {
                this.status = null;
                this.emit('status', null);
            }
            if (!this.closed) {
                this.retry = setTimeout(() => this.start(), RETRY_MS);
            }
        });
    }

    _write(m) {
        if (this.sock && this.connected) {
            this.sock.write(`${JSON.stringify(m)}\n`);
        }
    }

    /* The car's state is kept and sent again on connecting; commands are not. */
    send(m) {
        if (m.car) {
            this.last.car = m;
        }
        this._write(m);
    }

    stop() {
        this.closed = true;
        clearTimeout(this.retry);
        if (this.sock) {
            this.sock.destroy();
        }
    }
}

module.exports = { BarLink, SOCKET };
