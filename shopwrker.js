/*
* Copyright (c) 2013, Leon Sorokin
* All rights reserved. (MIT Licensed)
*
* sweatshop.js - parallel processing for web workers
*/

function OkMsg(data, extra) {
	this.jsonrpc = "2.0";
	this.result = data;
	this.id = null;

	// non-standard out-of-band data (like error.data in error responses)
	// use this for debug stuff, etc...
	this.extra = {};

	if (extra) {
		for (var i in extra)
			this.extra[i] = extra[i];
	}
}

function ErrMsg(code, message, data) {
	this.jsonrpc = "2.0";
	this.error = {
		code: code,
		message: message,
		data: data,
	};
	this.id = null;
}

self.onmessage = function(e) {
	var msg,
		d = e.data,
		t = Date.now();

	if (methods[d.method]) {
		try {
			var result = methods[d.method].apply(self, d.params);

			if (!(result instanceof OkMsg || result instanceof ErrMsg))
				msg = new OkMsg(result);
			else
				msg = result;
		}
		catch(e) {
			// assume generic error
			// TODO: switch on Error class and translate to RPC error codes
			if (e instanceof Error)
				msg = new ErrMsg(-32603, e.message);
		}
	}
	else
		msg = new ErrMsg(-32601, "Method '" + d.method + "' not found");

	msg.id = d.id;

	if (msg instanceof OkMsg)
		msg.extra.time	= Date.now() - t;

	postMessage(msg);
};

// callable methods
methods = {};
