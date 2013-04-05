sweatshop.js
------------
parallel processing via web workers _(MIT Licensed)_


### Introduction
---

This is a thin framework for processing large amounts of data in parallel. Fundamentally, it's an API for defining and executing sequences of actions - some of which can be parallelized across workers and others that cannot. Think of it as 1 part [map-reduce](http://en.wikipedia.org/wiki/MapReduce), 1 part persistent [web workers](http://www.html5rocks.com/en/tutorials/workers/basics/) and 1 part [deferreds/promises](http://domenic.me/2012/10/14/youre-missing-the-point-of-promises/).

### Features
---

* Lightweight (~4k min, ~1.5k gz)
* Fluent, chainable API
* Waterfall data-passing
* Promise-backed by any of
  * [jQuery](https://github.com/jquery/jquery)
  * [RSVP](https://github.com/tildeio/rsvp.js)
  * [when](https://github.com/cujojs/when)
  * [Vow](https://github.com/dfilatov/jspromise)
  * [Q](https://github.com/kriskowal/q)
* Included sharders
  * Array and Typed Array
  * CanvasContext2d
  * Item weight

### Basic Pattern
---

```js
// create a 4-worker shop
var shop = new Sweatshop("myWrker.js", 4);

// define a sequence
var seqn = shop.seqn(function(shop) {
    this
    .then(function(input) {
        // handle initial data passed into sequence, manip it and
        // return into the "result" parameter below
    })
    .call("methodA", function(result) {
        // return arg array for each worker's methodA
    })
    .then(function(results) {
        // process the results array returned by workers
    })
    .call("methodB", function(result) {
        // return arg array for each worker's methodB
    })
    .then(function(results) {
        // process the result array returned by workers
    });
});

// prepare some data
var input = [10,20,30,40,50,60,70,80,90];

// execute the sequence
seqn.proc(input)
    .then(function(result) {
        // handle last step's result here

        // terminate workers
        shop.close();
    });
```

### Documentation
---

_soon..._