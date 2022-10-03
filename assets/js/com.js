class com {
    constructor() {
        this.isConnected = false;
        this.filters;
        this.baudrate;
    }

    async setConnection() {
        this.device = await navigator.serial.requestPort({
            filters: this.filters
        });
        await this.device.open({
            baudRate: this.baudrate
        });
        this.isConnected = true;
    }

    closeConnection() {
        this.device.close();
        this.isConnected = false;
    }

    async writeData(data) {
        const writer = this.device.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
    }

    pad(n, width = 2, z) {
        z = z || '0';
        n = n + '';
        return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
    }

    getHex(hex, length) {
        return this.pad(Number(hex).toString(16), length).toUpperCase();
    }
}

class rfid extends com {
	constructor() {
        super();
        this.filters = [{
            usbVendorId: 0x0D2C,
            usbProductId: 0x032A
        }];
        this.baudrate = 19200;
        this.stream = {
            isStream: false,
            lastMessage: []
        };
    }

    crc16(
        data = [],
        xor_in = 0xFFFF,
        xor_out = 0xFFFF,
        poly = 0x1021
    ) {
        if (data.length != 0) {
            let reg = xor_in;
            for (let octet of data) {
                for (let pos = 0; pos < 8; pos++) {
                    let top_bit = reg & 0x8000;
                    if (octet & (0x80 >> pos))
                        top_bit ^= 0x8000;
                    reg <<= 1
                    if (top_bit)
                        reg ^= poly;
                }
                reg &= 0xFFFF;
            }
            return reg ^ xor_out;
        } else return false;
    }

    readMessage(_message, _raw = true) {
        return {
            headers: {
                startByte: _message[0],
                length: Number(`0x${_message[1]}${_message[2]}`),
                commandCode: _message[3],
                errorCode: _message[4],
                bcc: Number(`0x${_message[_message.length - 3]}${_message[_message.length - 2]}`),
            },
            message: (() => {
                if (_raw) {
                    return _message.slice(5, _message.length - 3);
                } else {
                    switch (_message[3]) {
                        case 'FE':
                            return {
                                afi: _message[5],
                                responseOptions: _message[6],
                                numberOfTags: Number(`0x${_message[7]}`),
                                tags: (() => {
                                    let _ret = [];
                                    for (let i = 8; i < _message.length - 2; i += 8)
                                        _ret.push(_message.slice(i, i + 8).join(''));
                                    return _ret;
                                })(),
                            }
                        case '11':
                            return `3M Reader Version ${_message[6]}.${_message[7]}.${_message[8]}`;
                        break;
                    }
                }
            })()
        }
    }

    async getDataSingle() {
        let answer = [],
            len = 0,
            cntLenTrg = true;

        while (this.device.readable) {
            const reader = this.device.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    answer = answer.concat(Array.from(value));
                    if (!done) {
                        if (answer.length >= 3) {
                            if (cntLenTrg) {
                                len = Number(`0x${this.pad(answer[1].toString(16))}${answer[2].toString(16)}`);
                                cntLenTrg = false;
                            }
                            if (answer.length == (len + 3)) {
                                break;
                            }
                        }
                    } else {
                        reader.releaseLock();
                    }
                }
            } catch (error) {
                return error;
            } finally {
                reader.releaseLock();
                for (let key in answer)
                    answer[key] = this.pad(answer[key].toString(16).toUpperCase());
                return this.readMessage(answer, false);
            }
        }
    }

    async getDataInStream() {
        while (this.device.readable) {
            const reader = this.device.readable.getReader();
            
            let answer = [],
                len = 0,
                cntLenTrg = true,
                resetTrg = false;
            
            try {
                while (this.stream.isStream) {
                    const { value, done } = await reader.read();
                    if (resetTrg) {
                        answer = [];
                        len = 0;
                        cntLenTrg = true;
                        resetTrg = false;
                    }
                    answer = answer.concat(Array.from(value));
                    if (!done) {
                        if (answer.length >= 3) {
                            if (cntLenTrg) {
                                len = Number(`0x${this.pad(answer[1].toString(16))}${answer[2].toString(16)}`);
                                cntLenTrg = false;
                            }
                            if (answer.length == (len + 3)) {
                                for (let key in answer)
                                    answer[key] = this.pad(answer[key].toString(16).toUpperCase());
                                this.stream.lastMessage = this.readMessage(answer, false);
                                resetTrg = true;
                            }
                        }
                    }
                }
            } catch (error) {
                this.stream.isStream = false;
                console.log(`WARNING: ${error}`);
                reader.releaseLock();
            } finally {
                reader.releaseLock();
                break;
            }
        }
    }

    async sendCommand(_message) {
        let _pad = this.pad(_message.length + 2, 4),
            _crc = 0x0;
        _message = [
            Number(`0x${_pad.substring(0, 2)}`),
            Number(`0x${_pad.substring(2, 4)}`),
        ].concat(_message);
        _crc = this.crc16(_message).toString(16);
        _message = new Uint8Array([0xD6].concat(_message.concat([
            Number(`0x${_crc.substring(0, 2)}`),
            Number(`0x${_crc.substring(2, 4)}`),
        ])));
        this.writeData(_message);
    }
}
