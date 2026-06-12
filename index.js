var Service, Characteristic;

const packageJson = require("./package.json");
const request = require("request");
const jp = require("jsonpath");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory(
        "homebridge-garage-door-shelly1",
        "GarageDoorOpener",
        GarageDoorOpener
    );
};

const STATES = {
    OPEN: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3
};

function GarageDoorOpener(log, config) {
    this.log = log;
    this.config = config;

    this.name = config.name;

    this.openURL = config.openURL;
    this.closeURL = config.closeURL;

    this.openTime = config.openTime || 10;
    this.closeTime = config.closeTime || 10;

    this.switchOff = config.switchOff || false;
    this.switchOffDelay = config.switchOffDelay || 2;

    this.autoLock = config.autoLock || false;
    this.autoLockDelay = config.autoLockDelay || 20;

    this.manufacturer = config.manufacturer || packageJson.author.name;
    this.serial = config.serial || packageJson.version;
    this.model = config.model || packageJson.name;
    this.firmware = config.firmware || packageJson.version;

    this.username = config.username || null;
    this.password = config.password || null;
    this.timeout = config.timeout || 3000;

    this.http_method = config.http_method || "GET";

    this.polling = config.polling || false;
    this.pollInterval = config.pollInterval || 120;
    this.movementPollInterval = config.movementPollInterval || 2;

    this.statusURL = config.statusURL;
    this.statusKey = config.statusKey || "$.inputs[0].input";

    this.statusValueOpen = config.statusValueOpen || "0";
    this.statusValueClosed = config.statusValueClosed || "1";

    this.auth = null;
    if (this.username && this.password) {
        this.auth = {
            user: this.username,
            pass: this.password,
        };
    }

    // STATE MACHINE
    this.state = "UNKNOWN";
    this.movementToken = 0;
    this.pollTimer = null;
    this.timeoutTimer = null;

    this.service = new Service.GarageDoorOpener(this.name);
}

/* -------------------------
   HTTP
--------------------------*/
GarageDoorOpener.prototype._httpRequest = function (url, body, method, callback) {
    request(
        {
            url,
            body,
            method: this.http_method,
            timeout: this.timeout,
            rejectUnauthorized: false,
            auth: this.auth,
        },
        (error, response, body) => callback(error, response, body)
    );
};

/* -------------------------
   SENSOR STATUS
--------------------------*/
GarageDoorOpener.prototype._fetchStatus = function (callback) {
    this._httpRequest(this.statusURL, "", "GET", (error, response, body) => {
        if (error) return callback(error);

        try {
            const json = typeof body === "string" ? JSON.parse(body) : body;

            const raw = jp.query(json, this.statusKey).pop();

            let value = -1;

            if (new RegExp(this.statusValueOpen).test(raw)) value = 0;
            else if (new RegExp(this.statusValueClosed).test(raw)) value = 1;

            callback(null, value);
        } catch (e) {
            callback(e);
        }
    });
};

/* -------------------------
   STATE MACHINE CORE
--------------------------*/
GarageDoorOpener.prototype._setState = function (state, source = "internal") {
    this.state = state;

    let hk;

    switch (state) {
        case "OPEN":
            hk = Characteristic.CurrentDoorState.OPEN;
            break;
        case "CLOSED":
            hk = Characteristic.CurrentDoorState.CLOSED;
            break;
        case "OPENING":
            hk = Characteristic.CurrentDoorState.OPENING;
            break;
        case "CLOSING":
            hk = Characteristic.CurrentDoorState.CLOSING;
            break;
        default:
            return;
    }

    this.service.updateCharacteristic(
        Characteristic.CurrentDoorState,
        hk
    );

    // sync Target when sensor confirms final state
    if (source === "sensor" || source === "sensor-final") {
        if (state === "OPEN") {
            this.service.updateCharacteristic(
                Characteristic.TargetDoorState,
                Characteristic.TargetDoorState.OPEN
            );
        }

        if (state === "CLOSED") {
            this.service.updateCharacteristic(
                Characteristic.TargetDoorState,
                Characteristic.TargetDoorState.CLOSED
            );
        }

        // also clear movement state
        this.movementToken++;
    }

    if (this.config.debug) {
        this.log.debug(`STATE => ${state} (${source})`);
    }
};

/* -------------------------
   SENSOR SYNC (IDLE ONLY)
--------------------------*/
GarageDoorOpener.prototype._syncFromSensor = function () {
    if (this.state === "OPENING" || this.state === "CLOSING") return;

    this._fetchStatus((err, value) => {
        if (err) return;

        if (value === 0) this._setState("OPEN", "sensor");
        if (value === 1) this._setState("CLOSED", "sensor");
    });
};

/* -------------------------
   COMMAND HANDLER
--------------------------*/
GarageDoorOpener.prototype.setTargetDoorState = function (value, callback) {
    const desired = value === 0 ? "OPEN" : "CLOSED";

    // nothing to do if door is already at correct state
    if (
        (desired === "OPEN" && this.state === "OPEN") ||
        (desired === "CLOSED" && this.state === "CLOSED")
    ) {
	this.log.debug("%s requested but current state is %s",desired, this.state);
        return callback();
    }

    this.movementToken++;
    const token = this.movementToken;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    this._setState(desired === "OPEN" ? "OPENING" : "CLOSING", "command");

    const url = value === 1 ? this.closeURL : this.openURL;

    this._httpRequest(url, "", this.http_method, (error) => {
        if (error) {
            this.log.warn("Command error: %s", error.message);
            return callback(error);
        }

        this.service.updateCharacteristic(
            Characteristic.TargetDoorState,
            value
        );

        this.log.debug("Setting targetDoorState to %s", desired);
        this._startMovementMonitor(desired, token);

        callback();
    });
};

/* -------------------------
   MOVEMENT MONITOR
--------------------------*/
GarageDoorOpener.prototype._startMovementMonitor = function (desired, token) {
    const targetState = desired;

    this.pollTimer = setInterval(() => {
        if (token !== this.movementToken) return;

        this._fetchStatus((err, value) => {
            if (err) return;

            const reached =
                (targetState === "OPEN" && value === 0) ||
                (targetState === "CLOSED" && value === 1);

            if (reached) {
                clearInterval(this.pollTimer);
                clearTimeout(this.timeoutTimer);

            this._setState(targetState, "sensor-final");

            this.service.updateCharacteristic(
               Characteristic.TargetDoorState,
               targetState === "OPEN"
                  ? Characteristic.TargetDoorState.OPEN
                  : Characteristic.TargetDoorState.CLOSED
            );
         }
        });
    }, this.movementPollInterval * 1000);

    this.timeoutTimer = setTimeout(() => {
        if (token !== this.movementToken) return;

        clearInterval(this.pollTimer);

        this.log.warn("Movement timeout → resyncing sensor");

        this._syncFromSensor();
    }, (desired === "OPEN" ? this.openTime : this.closeTime) * 1000);
};

/* -------------------------
   IDENTIFY
--------------------------*/
GarageDoorOpener.prototype.identify = function (callback) {
    this.log("Identify requested");
    callback();
};

/* -------------------------
   SERVICES
--------------------------*/
GarageDoorOpener.prototype.getServices = function () {
    this.informationService = new Service.AccessoryInformation();

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(Characteristic.Model, this.model)
        .setCharacteristic(Characteristic.SerialNumber, this.serial)
        .setCharacteristic(Characteristic.FirmwareRevision, this.firmware);

    this.service
        .getCharacteristic(Characteristic.TargetDoorState)
        .on("set", this.setTargetDoorState.bind(this));

    if (this.polling) {
        this._syncFromSensor();

        setInterval(() => {
            this._syncFromSensor();
        }, this.pollInterval * 1000);
    } else {
        this.service.updateCharacteristic(
            Characteristic.CurrentDoorState,
            STATES.CLOSED
        );

        this.service.updateCharacteristic(
            Characteristic.TargetDoorState,
            STATES.CLOSED
        );
    }

    return [this.informationService, this.service];
};
