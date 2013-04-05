/*
* Copyright (c) 2013, Leon Sorokin
* All rights reserved. (MIT Licensed)
*
* sweatshop.js - parallel processing via web workers
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

	// sequence factory
	Sweatshop.prototype.seqn = function seqn(setup, teardn) {
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

		// flags used to augment waterfall'd args from call->then
		this._currCall = false;
		this._lastCall = false;

		// temp holder for pending responses
		this.dfrds = {};
		this.chain.push(shop.prom(this.dfrd0));

		this.setup(shop);
//		teardn.apply(this);
	}

	// @method should be string (2-arg sig) or hash of multiple {"method": params} (1-arg sig)
	Sequence.prototype.call = function call(method, params, recycle) {
		recycle = recycle || false;

		var self = this,
			shop = this.shop;

		var callpairs = {};
		if (arguments.length == 1 && method instanceof Object)
			callpairs = method;
		else
			callpairs[method] = params;

		var fn = function(result) {
			self.dfrds = {};
			var proms = [];

			for (var j in callpairs) {
				var meth = j,
					args = callpairs[j],
					argFn;

				if (args instanceof Array) {
					argFn = function(result, wrkrId, tmpCtx, cycle) {
						if (cycle == 0)
							return args;
					};
				}
				else if (args instanceof Sharder) {
					argFn = function(result, wrkrId, tmpCtx, cycle) {
						return args.next.apply(args, arguments);	// [0]
					};
				}
				else if (typeof args == "function") {
					argFn = args;
				}
				else {
					argFn = function(result, wrkrId, tmpCtx, cycle) {
						if (cycle == 0)
							return result;
					};
				}

				var cycle = 0, wrkrId = 0, emptyloop = true, argu, tmpCtx = {};

				while (1) {
					// re-loop if there were any args provided on prior loop
					if (wrkrId == shop._num) {
						if (emptyloop || !recycle)
							break;

						wrkrId = 0;
						emptyloop = true;
						cycle++;
					}
					else {
						argu = argFn(result, wrkrId, tmpCtx, cycle);

						// check if a sharder is returned on first call
						if (wrkrId == 0 && cycle == 0 && argu instanceof Sharder) {
							args = argu;
							argFn = function(result, wrkrId, tmpCtx, cycle) {
								return args.next.apply(args, arguments);		// [0]
							};
							argu = argFn(result, wrkrId, tmpCtx, cycle);
						}

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

		this._currCall = true;

		// TODO?: also pass in fail, prog
		return this.then(fn);
	}

	Sequence.prototype.then = function then(done, fail, prog) {
		var last = this.chain[this.chain.length - 1],
			self = this,
			doneFn = done;

		// intercept and append add'l convenience params from
		// raw JSON-RPC response array (only for call->then pairs)
		if (this._lastCall && !this._currCall) {
			doneFn = function(result) {
				var args = [];

				// group responses by wrkrId and check if it's a recycle'd resp (multiple per wrkr)
				var wid, recyc = false, resps = [];
				result.forEach(function(resp){
					wid = +resp.id.split(":")[0];

					if (!resps[wid])
						resps[wid] = [];

					resps[wid].push(resp);		// maybe use the msg sequence id here instead of push()

					if (resps[wid].length > 1)
						recyc = true;
				});

				// TODO: group other params
				if (recyc) {
					// use resps
				}
				else {
					// aggregated .result
					args.push(result.map(function(resp) {return resp.result;}));
					// aggregated .extra (my non-standard RPC addition for out-of-band response info)
					args.push(result.map(function(resp) {return resp.extra;}));
					// raw responses
					args.push(result);
				}

				return done.apply(this, args);
			};
		}

		this._lastCall = this._currCall;
		this._currCall = false;

		this.chain.push(last.then(doneFn, fail, prog));

		return this;
	};

	// TODO: @spread param would be useful here but promises cannot be resolved with multiple values :(
	Sequence.prototype.proc = function proc(data) {
		var seq;

		if (!this._fired)
			seq = this;
		else
			seq = new Sequence(this.shop, this.setup, this.teardn);

		var self = seq,
			shop = seq.shop;

		// respawn
		// TODO: fire teardn() here?
		shop.close().spawn();

		shop.wrkrs.forEach(function(wrkr){
			wrkr.onmessage = function(e) {
				self.dfrds[e.data.id].resolve(e.data);
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
	function Sharder(data, chunks) {
		// this must be implemented by sharders and return [part, offset] or undefined
		this.next = function() {};
	}

	// sharder constructors
	Sweatshop.Sharder = {
		// TODO: use faster .subarray() for sharding typed arrays
		// spreads @data array over @chunks groups
		"Array": function(data, chunks, unary) {
			Sharder.apply(this, arguments);

			if (unary && chunks != data.length)
				throw new Error("Unary sharding requires one item per shard.");

			if (chunks > data.length)
				chunks = data.length;

			var len = data.length,
				pos = 0,
				rem = len % chunks,
				siz = (len - rem) / chunks,
				end = false;

			this.next = function() {
				if (end) return;

				var prt, pos0 = pos;

				if (len - (pos + siz) == rem) {	// last
					prt = data.slice(pos);
					pos = len - 1;
					end = true;
				}
				else {
					prt = data.slice(pos, pos + siz);
					pos += siz;
				}

				return [unary ? prt[0] : prt, pos0];
			};
		},

		// spreads @data array over @chunks groups by weight returned from @getWt() applied to each element
		// data gets sorted by weight first, so indicies are discarded; pre-tag the elems yourself if needed
		ItemWt: function(data, chunks, getWt) {
			Sharder.apply(this, arguments);

			if (chunks > data.length)
				chunks = data.length;

			var items = [], sum = 0, wt;
			data.forEach(function(itm,idx){
				wt = getWt(itm);
				sum += wt;
				items.push([itm,wt]);
			});

			items.sort(function(a,b){
				return a[1] < b[1];
			});

			var p = 0, dir = 1, parts = [], sums = [], targ = sum/chunks, itm;

			for (var j = 0; j < chunks; j++) {
				parts[j] = [];
				sums[j] = 0;
			}

			// sweep back and forth to distribute weights
			while (items.length) {
				if (sums[p] < targ) {
					itm = items.shift();
					parts[p].push(itm[0]);
					sums[p] += itm[1];
				}

				// invert sweep
				if (p == 0 && dir == -1 || p == chunks-1 && dir == 1)
					dir *= -1;
				else
					p += dir;
			}

			this.next = function() {
				var prt = parts.shift(),
					pos0 = chunks - parts.length - 1;

				if (prt)
					return [prt, null];
			};
		},

		// spreads lines of pixels over @chunks groups
		// @data: CanvasRenderingContext2D
		Ctx2d: function(data, chunks) {
			Sharder.apply(this, arguments);

			var can = data.canvas;

			if (chunks > can.height)
				chunks = can.height;

			var	len = can.height,			// num of horiz px lines
				pos = 0,
				rem = len % chunks,
				siz = (len - rem) / chunks,
				end = false;

			this.next = function() {
				if (end) return;

				var prt, pos0 = pos * can.width;

				if (len - (pos + siz) == rem) {	// last
					prt = data.getImageData(0, pos, can.width, siz + rem);
					pos = len - 1;
					end = true;
				}
				else {
					prt = data.getImageData(0, pos, can.width, siz);
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