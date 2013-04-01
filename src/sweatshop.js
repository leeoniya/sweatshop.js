/*
* Copyright (c) 2013, Leon Sorokin
* All rights reserved. (MIT Licensed)
*
* sweatshop.js - parallel processing for web workers
*/

function Sweatshop(src, num) {
	this._num = num;
	this._src = src;
	this._seqs = {};

	this.wrkrs = [];
	this.reqId = 1e3;
}

(function() {
	// detect and hook into available promise libs
	hookDeferredLib(Sweatshop.prototype);

	function hookDeferredLib(proto) {
		var fn = "function";

		// when - https://github.com/cujojs/when
		if (typeof when === fn) {
			proto.defer = function()      {return when.defer();};
			proto.prom  = function(dfrd)  {return dfrd.promise;};
			proto.all   = function(proms) {return when.all(proms)};
		}
		// jQuery - https://github.com/jquery/jquery
		else if (typeof jQuery === fn) {
			proto.defer = function()      {return new jQuery.Deferred();};
			proto.prom  = function(dfrd)  {return dfrd.promise();};
			// hack to add a passthru adapter for args cause jQuery's $.when is like Q.spread or when/apply, not .all()
			var adapt   = function() {return Array.prototype.slice.call(arguments)};
			proto.all   = function(proms) {return jQuery.when.apply(jQuery, proms).then(adapt,adapt,adapt)};
		}
		// Q - https://github.com/kriskowal/q
		else if (typeof Q === fn) {
			proto.defer = function()      {return Q.defer();};
			proto.prom  = function(dfrd)  {return dfrd.promise;};
			proto.all   = function(proms) {return Q.all(proms)};
		}
		// RSVP - https://github.com/tildeio/rsvp.js
		else if (typeof RSVP === fn) {
			proto.defer = function()      {return new RSVP.Promise();};
			proto.prom  = function(dfrd)  {return dfrd};
			proto.all   = function(proms) {return RSVP.all(proms)};
		}
		// Vow - https://github.com/dfilatov/jspromise
		else if (typeof Vow === fn) {
			proto.defer = function()      {return Vow.promise();};
			proto.prom  = function(dfrd)  {return dfrd};
			proto.all   = function(proms) {return Vow.all(proms)};
		}
		// barf
		else {
			throw new Error("Sweatshop: no deferred/promise libs detected.");
		}
	}

	function typeOf(obj) {
		return Object.prototype.toString.call(obj).slice(8,-1);
	}

	// sharder factory
	Sweatshop.prototype.shard = function shard(data, isUnary, getWeight) {
		var type = typeOf(data);

		if (typeof getWeight === "function") {
			if (type !== "Array")
				throw new Error("Weighted sharding requires the data to be an array of objects, but '" + type + "' was provided.");
			return new Sweatshop.Sharder.ItemWt(data, this._num, getWeight);
		}
		// accounts for plain and typed arrays
		else if (type.substr(-5) === "Array")
			return new Sweatshop.Sharder.Array(data, this._num, isUnary);
		else if (type.substr(-9) === "Context2D")
			return new Sweatshop.Sharder.Ctx2d(data, this._num);
		else
			throw new Error("No suitable sharder for datatype '" + type + "' could not be identified.");
	};

	// sequence factory
	Sweatshop.prototype.seq = function seq(setup, teardn) {
		return new Sequence(this, setup, teardn);
	};

	// creates workers
	Sweatshop.prototype.spawn = function spawn() {
		for (var i = 0; i < this._num; i++) {
			var wrkr = new Worker(this._src);
			wrkr.id = i;
			this.wrkrs[i] = wrkr;
		}

		return this;
	};

	// terminates workers
	Sweatshop.prototype.close = function close() {
		for (var i in this.wrkrs)
			this.wrkrs[i].terminate();

		return this;
	};

/*--------------------------------Sequence----------------------------------*/

	function Sequence(shop, setup, teardn) {
		this.shop = shop;
		this.setup = setup;
		this.teardn = teardn;

		this.chain = [];
		this.dfrd0 = shop.defer();
		this._fired = false;

		// temp holder for pending responses
		this.dfrds = {};
		this.chain.push(shop.prom(this.dfrd0));

		this.setup(shop);
//		teardn.apply(this);
	}

	// @method should be string (2-arg sig) or hash of multiple {"method": params} (1-arg sig)
	Sequence.prototype.call = function call(method, params) {
		var self = this,
			shop = this.shop;

		var callpairs = {};
		if (arguments.length > 1)
			callpairs[method] = params;
		else if (method instanceof Object)
			callpairs = method;

		var fn = function(result) {
			self.dfrds = {};
			var proms = [];

			for (var j in callpairs) {
				var meth = j,
					args = callpairs[j];

				if (args instanceof Array) {
					var argArr = args;
					args = function(result, cycle, wrkrId, tmpCtx) {
						// prevents infinite loops
						return cycle > 0 ? undefined : argArr;
					}
				}
				else if (args instanceof Sharder) {
					var shrd = args;
					args = function(result, cycle, wrkrId, tmpCtx) {
						var argu = shrd.next.apply(shrd, arguments);

						// TODO: figure out what to do with returned offset
						if (argu)
							return [argu[0]];
					};
				}

				var cycle = 0, wrkrId = 0, emptyloop = true, argu, tmpCtx = {};

				while (1) {
					// re-loop if there were any args provided on prior loop
					if (wrkrId == shop._num) {
						if (emptyloop)
							break;

						wrkrId = 0;
						emptyloop = true;
						cycle++;
					}
					else {
						argu = args(result, cycle, wrkrId, tmpCtx);

						if (argu) {
							emptyloop = false;

							// message ids are globally sequential and prefixed by worker to which they're sent
							var reqId = wrkrId + ":" + shop.reqId++;

							self.dfrds[reqId] = shop.defer();
							proms.push(shop.prom(self.dfrds[reqId]));

							// TODO: investigate JSON-RPC batching, worse progress notifs then?
							shop.wrkrs[wrkrId].postMessage({
								jsonrpc: "2.0",
								method: meth,
								params: argu,
								id: reqId,
							});
						}

						wrkrId++;
					}
				}
			}

			return shop.all(proms);
		};

		// TODO?: also pass in fail, prog
		return this.then(fn);
	}

	Sequence.prototype.then = function then(done, fail, prog) {
		var last = this.chain[this.chain.length - 1];

		var doneFn = function(result) {
			var args = [result];

			// intercept and append add'l convenience params from raw MessageEvent array
			if (result instanceof Array && result[0] instanceof MessageEvent) {
				// array of .data (which hold RPC responses)
				var rpcResps = result.map(function(msgEvt) {
					return msgEvt.data;
				});
				args.push(rpcResps);

				// array of data.result (RPC results)
				var rpcReslts = rpcResps.map(function(rpcResp) {
					return rpcResp.result;
				});
				args.push(rpcReslts);

				// array of .data.extra (my non-standard RPC addition for out-of-band response info)
				if (rpcResps[0].extra) {
					var rpcExtras = rpcResps.map(function(rpcResp) {
						return rpcResp.extra;
					});
					args.push(rpcExtras);
				}
			}

			return done.apply(this, args);
		};

		this.chain.push(last.then(doneFn, fail, prog));

		return this;
	};

	Sequence.prototype.proc = function proc(data) {
		var seq;

		if (!this._fired)
			seq = this;
		else
			seq = new Sequence(this.shop, this.setup, this.teardn);

		var self = seq,
			shop = seq.shop;

		// respawn
		// todo: fire teardn() here?
		shop.close().spawn();

		shop.wrkrs.forEach(function(wrkr){
			wrkr.onmessage = function(e) {
				self.dfrds[e.data.id].resolve(e);
				// also reject on RPC e.data.error...
			};

			wrkr.onerror = function(e) {
				self.dfrds[e.data.id].reject(e.message);
			};
		});

		// go!
		seq.dfrd0.resolve(data);
		seq._fired = true;

		return seq;
	};

/*--------------------------------Sharders----------------------------------*/

	// base proto for instanceof checks
	function Sharder(data, num) {
		// this must be implemented by sharders and return [part, offset]
		this.next = function() {};
	}

	// sharder constructors
	Sweatshop.Sharder = {
		// TODO: use faster .subarray() for sharding typed arrays
		// spreads arr over @num groups
		"Array": function(arr, num, isUnary) {
			Sharder.apply(this, arguments);

			if (isUnary && num !== arr.length)
				throw new Error("Unary sharding requires one item per shard.");

			if (num > arr.length)
				num = arr.length;

			var len = arr.length,
				pos = 0,
				rem = len % num,
				siz = (len - rem) / num,
				end = false;

			this.next = function() {
				if (end) return undefined;

				var prt, pos0 = pos;

				if (len - (pos + siz) == rem) {	// last
					prt = arr.slice(pos);
					pos = len - 1;
					end = true;
				}
				else {
					prt = arr.slice(pos, pos + siz);
					pos += siz;
				}

				return [isUnary ? prt[0] : prt, pos0];
			};
		},

		// spreads @items over @num groups by weight returned by calling @getWt(itm)
		ItemWt: function(items, num, getWt) {
			Sharder.apply(this, arguments);

			if (num > items.length)
				num = items.length;

			var itms2 = [], sum = 0, wt;
			items.forEach(function(itm,idx){
				wt = getWt(itm);
				sum += wt;
				itms2.push([itm,wt]);
			});

			itms2.sort(function(a,b){
				return a[1] < b[1];
			});

			var p = 0, dir = 1, parts = [], sums = [], targ = sum/num, itm;

			for (var j = 0; j < num; j++) {
				parts[j] = [];
				sums[j] = 0;
			}

			// sweep back and forth to distribute weights
			while (itms2.length) {
				if (sums[p] < targ) {
					itm = itms2.shift();
					parts[p].push(itm[0]);
					sums[p] += itm[1];
				}

				// invert sweep
				if (p == 0 && dir == -1 || p == num-1 && dir == 1)
					dir *= -1;
				else
					p += dir;
			}

			this.next = function() {
				var prt = parts.shift(),
					pos0 = num - parts.length - 1;

				return prt ? [prt, pos0] : null;
			};
		},

		// spreads lines of pixels over @num groups
		Ctx2d: function(ctx2d, num) {
			Sharder.apply(this, arguments);

			var can = ctx2d.canvas;

			if (num > can.height)
				num = can.height;

			var	len = can.height,			// num of horiz px lines
				pos = 0,
				rem = len % num,
				siz = (len - rem) / num,
				end = false;

			this.next = function() {
				if (end) return null;

				var prt, pos0 = pos * can.width;

				if (len - (pos + siz) == rem) {	// last
					prt = ctx2d.getImageData(0, pos, can.width, siz + rem);
					pos = len - 1;
					end = true;
				}
				else {
					prt = ctx2d.getImageData(0, pos, can.width, siz);
					pos += siz;
				}

				return [prt, pos0];
			};
		},
	};

	// inherit from base Sharder
	for (var k in Sweatshop.Sharder) {
		Sweatshop.Sharder[k].prototype = Object.create(Sharder.prototype);
		Sweatshop.Sharder[k].prototype.constructor = Sweatshop.Sharder[k];
	}
})();