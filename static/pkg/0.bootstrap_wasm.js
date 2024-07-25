(window["webpackJsonp"] = window["webpackJsonp"] || []).push([[0],{

/***/ "../pkg/snippets/wasm-pass-9c8b3b5311558714/www/rand_int.js":
/*!******************************************************************!*\
  !*** ../pkg/snippets/wasm-pass-9c8b3b5311558714/www/rand_int.js ***!
  \******************************************************************/
/*! exports provided: getRandomInt */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, \"getRandomInt\", function() { return getRandomInt; });\nfunction getRandomInt() {\n  const crypto = window.crypto || window.msCrypto;\n  const maxUint32 = 0xffffffff;\n  const maxSafeInt = Number.MAX_SAFE_INTEGER;\n\n  // Helper function to get a random 53-bit integer\n  function getRandom53BitInt() {\n    const array = new Uint32Array(12);\n    crypto.getRandomValues(array);\n\n    const high = array[0] & 0x001fffff; // 21 bits from the first 32-bit int\n    const low = array[1]; // 32 bits from the second 32-bit int\n\n    return high * (maxUint32 + 1) + low; // Combine to get a 53-bit integer\n  }\n\n  let randomInt = getRandom53BitInt();\n\n  return randomInt % maxSafeInt;\n}\n\n\n\n\n//# sourceURL=webpack:///../pkg/snippets/wasm-pass-9c8b3b5311558714/www/rand_int.js?");

/***/ }),

/***/ "../pkg/wasm_pass.js":
/*!***************************!*\
  !*** ../pkg/wasm_pass.js ***!
  \***************************/
/*! exports provided: __wbg_set_wasm, get_pass, get_pass_strength, __wbindgen_throw */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony import */ var _wasm_pass_bg_wasm__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./wasm_pass_bg.wasm */ \"../pkg/wasm_pass_bg.wasm\");\n/* harmony import */ var _wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./wasm_pass_bg.js */ \"../pkg/wasm_pass_bg.js\");\n/* harmony reexport (safe) */ __webpack_require__.d(__webpack_exports__, \"__wbg_set_wasm\", function() { return _wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__[\"__wbg_set_wasm\"]; });\n\n/* harmony reexport (safe) */ __webpack_require__.d(__webpack_exports__, \"get_pass\", function() { return _wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__[\"get_pass\"]; });\n\n/* harmony reexport (safe) */ __webpack_require__.d(__webpack_exports__, \"get_pass_strength\", function() { return _wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__[\"get_pass_strength\"]; });\n\n/* harmony reexport (safe) */ __webpack_require__.d(__webpack_exports__, \"__wbindgen_throw\", function() { return _wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__[\"__wbindgen_throw\"]; });\n\n\n\nObject(_wasm_pass_bg_js__WEBPACK_IMPORTED_MODULE_1__[\"__wbg_set_wasm\"])(_wasm_pass_bg_wasm__WEBPACK_IMPORTED_MODULE_0__);\n\n\n\n//# sourceURL=webpack:///../pkg/wasm_pass.js?");

/***/ }),

/***/ "../pkg/wasm_pass_bg.js":
/*!******************************!*\
  !*** ../pkg/wasm_pass_bg.js ***!
  \******************************/
/*! exports provided: __wbg_set_wasm, get_pass, get_pass_strength, __wbindgen_throw */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* WEBPACK VAR INJECTION */(function(module) {/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, \"__wbg_set_wasm\", function() { return __wbg_set_wasm; });\n/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, \"get_pass\", function() { return get_pass; });\n/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, \"get_pass_strength\", function() { return get_pass_strength; });\n/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, \"__wbindgen_throw\", function() { return __wbindgen_throw; });\nlet wasm;\nfunction __wbg_set_wasm(val) {\n    wasm = val;\n}\n\n\nconst lTextDecoder = typeof TextDecoder === 'undefined' ? (0, module.require)('util').TextDecoder : TextDecoder;\n\nlet cachedTextDecoder = new lTextDecoder('utf-8', { ignoreBOM: true, fatal: true });\n\ncachedTextDecoder.decode();\n\nlet cachedUint8Memory0 = null;\n\nfunction getUint8Memory0() {\n    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {\n        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);\n    }\n    return cachedUint8Memory0;\n}\n\nfunction getStringFromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));\n}\n\nlet cachedInt32Memory0 = null;\n\nfunction getInt32Memory0() {\n    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {\n        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);\n    }\n    return cachedInt32Memory0;\n}\n/**\n* @param {number} length\n* @param {boolean} special\n* @returns {string}\n*/\nfunction get_pass(length, special) {\n    let deferred1_0;\n    let deferred1_1;\n    try {\n        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);\n        wasm.get_pass(retptr, length, special);\n        var r0 = getInt32Memory0()[retptr / 4 + 0];\n        var r1 = getInt32Memory0()[retptr / 4 + 1];\n        deferred1_0 = r0;\n        deferred1_1 = r1;\n        return getStringFromWasm0(r0, r1);\n    } finally {\n        wasm.__wbindgen_add_to_stack_pointer(16);\n        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);\n    }\n}\n\nlet WASM_VECTOR_LEN = 0;\n\nconst lTextEncoder = typeof TextEncoder === 'undefined' ? (0, module.require)('util').TextEncoder : TextEncoder;\n\nlet cachedTextEncoder = new lTextEncoder('utf-8');\n\nconst encodeString = (typeof cachedTextEncoder.encodeInto === 'function'\n    ? function (arg, view) {\n    return cachedTextEncoder.encodeInto(arg, view);\n}\n    : function (arg, view) {\n    const buf = cachedTextEncoder.encode(arg);\n    view.set(buf);\n    return {\n        read: arg.length,\n        written: buf.length\n    };\n});\n\nfunction passStringToWasm0(arg, malloc, realloc) {\n\n    if (realloc === undefined) {\n        const buf = cachedTextEncoder.encode(arg);\n        const ptr = malloc(buf.length, 1) >>> 0;\n        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);\n        WASM_VECTOR_LEN = buf.length;\n        return ptr;\n    }\n\n    let len = arg.length;\n    let ptr = malloc(len, 1) >>> 0;\n\n    const mem = getUint8Memory0();\n\n    let offset = 0;\n\n    for (; offset < len; offset++) {\n        const code = arg.charCodeAt(offset);\n        if (code > 0x7F) break;\n        mem[ptr + offset] = code;\n    }\n\n    if (offset !== len) {\n        if (offset !== 0) {\n            arg = arg.slice(offset);\n        }\n        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;\n        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);\n        const ret = encodeString(arg, view);\n\n        offset += ret.written;\n        ptr = realloc(ptr, len, offset, 1) >>> 0;\n    }\n\n    WASM_VECTOR_LEN = offset;\n    return ptr;\n}\n/**\n* @param {string} password\n* @returns {string}\n*/\nfunction get_pass_strength(password) {\n    let deferred2_0;\n    let deferred2_1;\n    try {\n        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);\n        const ptr0 = passStringToWasm0(password, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        const len0 = WASM_VECTOR_LEN;\n        wasm.get_pass_strength(retptr, ptr0, len0);\n        var r0 = getInt32Memory0()[retptr / 4 + 0];\n        var r1 = getInt32Memory0()[retptr / 4 + 1];\n        deferred2_0 = r0;\n        deferred2_1 = r1;\n        return getStringFromWasm0(r0, r1);\n    } finally {\n        wasm.__wbindgen_add_to_stack_pointer(16);\n        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);\n    }\n}\n\nfunction __wbindgen_throw(arg0, arg1) {\n    throw new Error(getStringFromWasm0(arg0, arg1));\n};\n\n\n/* WEBPACK VAR INJECTION */}.call(this, __webpack_require__(/*! ./../www/node_modules/webpack/buildin/harmony-module.js */ \"./node_modules/webpack/buildin/harmony-module.js\")(module)))\n\n//# sourceURL=webpack:///../pkg/wasm_pass_bg.js?");

/***/ }),

/***/ "../pkg/wasm_pass_bg.wasm":
/*!********************************!*\
  !*** ../pkg/wasm_pass_bg.wasm ***!
  \********************************/
/*! exports provided: memory, get_pass, get_pass_strength, __wbindgen_add_to_stack_pointer, __wbindgen_free, __wbindgen_malloc, __wbindgen_realloc */
/***/ (function(module, exports, __webpack_require__) {

eval("\"use strict\";\n// Instantiate WebAssembly module\nvar wasmExports = __webpack_require__.w[module.i];\n__webpack_require__.r(exports);\n// export exports from WebAssembly module\nfor(var name in wasmExports) if(name != \"__webpack_init__\") exports[name] = wasmExports[name];\n// exec imports from WebAssembly module (for esm order)\n/* harmony import */ var m0 = __webpack_require__(/*! ./snippets/wasm-pass-9c8b3b5311558714/www/rand_int.js */ \"../pkg/snippets/wasm-pass-9c8b3b5311558714/www/rand_int.js\");\n\n/* harmony import */ var m1 = __webpack_require__(/*! ./wasm_pass_bg.js */ \"../pkg/wasm_pass_bg.js\");\n\n\n// exec wasm module\nwasmExports[\"__webpack_init__\"]()\n\n//# sourceURL=webpack:///../pkg/wasm_pass_bg.wasm?");

/***/ }),

/***/ "./index.js":
/*!******************!*\
  !*** ./index.js ***!
  \******************/
/*! no exports provided */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony import */ var wasm_pass__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! wasm-pass */ \"../pkg/wasm_pass.js\");\n\n\nlet pass_el = document.getElementById(\"password\");\nlet gen_btn = document.getElementById(\"password-gen\");\n\nfunction delay(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nconst pass_strength_el = document.getElementById(\"strength-meter\");\nconst pass_input_el = document.getElementById(\"password-strength\");\n\nconst use_special_chars = document.getElementById(\"use-special\");\nconst pass_length = document.getElementById(\"password-len\");\n\nconst password_len = document.getElementById(\"password-len\");\nconst pass_len_display = document.getElementById(\"pass-len-dispaly\");\npassword_len.value = 14;\n\npassword_len.addEventListener(\"input\", function () {\n  pass_len_display.textContent = password_len.value;\n  generatePassword();\n});\n\ngen_btn.addEventListener(\"click\", async () => {\n  generatePassword();\n});\n\nuse_special_chars.addEventListener(\"change\", async () => {\n  generatePassword();\n});\n\nfunction generatePassword() {\n  let pass_len = parseInt(pass_length.value);\n  if (pass_len < 8 || pass_len > 128) {\n    alert(\"Password length must be between 8 and 128 characters\");\n    return;\n  }\n\n  let pass = Object(wasm_pass__WEBPACK_IMPORTED_MODULE_0__[\"get_pass\"])(pass_length.value, use_special_chars.checked);\n  pass_el.value = pass;\n}\n\npass_input_el.addEventListener(\"input\", (e) => {\n  const pass = e.target.value;\n\n  if (pass.length === 0) {\n    pass_strength_el.innerText = \"Weak\";\n    return;\n  }\n\n  let strength = Object(wasm_pass__WEBPACK_IMPORTED_MODULE_0__[\"get_pass_strength\"])(pass);\n\n  if (strength === \"Weak\") {\n    pass_strength_el.classList.forEach((c) => {\n      if (c.startsWith(\"btn-\")) {\n        pass_strength_el.classList.remove(c);\n      }\n    });\n    pass_strength_el.classList.add(\"btn-danger\");\n  } else if (strength === \"Medium\") {\n    pass_strength_el.classList.forEach((c) => {\n      if (c.startsWith(\"btn-\")) {\n        pass_strength_el.classList.remove(c);\n      }\n    });\n    pass_strength_el.classList.add(\"btn-warning\");\n  } else if (strength === \"Strong\") {\n    pass_strength_el.classList.forEach((c) => {\n      if (c.startsWith(\"btn-\")) {\n        pass_strength_el.classList.remove(c);\n      }\n    });\n    pass_strength_el.classList.add(\"btn-primary\");\n  } else if (strength === \"Very Strong\") {\n    pass_strength_el.classList.forEach((c) => {\n      if (c.startsWith(\"btn-\")) {\n        pass_strength_el.classList.remove(c);\n      }\n    });\n    pass_strength_el.classList.add(\"btn-success\");\n  }\n\n  pass_strength_el.innerText = Object(wasm_pass__WEBPACK_IMPORTED_MODULE_0__[\"get_pass_strength\"])(pass);\n});\n\ngeneratePassword();\n\n\n//# sourceURL=webpack:///./index.js?");

/***/ }),

/***/ "./node_modules/webpack/buildin/harmony-module.js":
/*!*******************************************!*\
  !*** (webpack)/buildin/harmony-module.js ***!
  \*******************************************/
/*! no static exports found */
/***/ (function(module, exports) {

eval("module.exports = function(originalModule) {\n\tif (!originalModule.webpackPolyfill) {\n\t\tvar module = Object.create(originalModule);\n\t\t// module.parent = undefined by default\n\t\tif (!module.children) module.children = [];\n\t\tObject.defineProperty(module, \"loaded\", {\n\t\t\tenumerable: true,\n\t\t\tget: function() {\n\t\t\t\treturn module.l;\n\t\t\t}\n\t\t});\n\t\tObject.defineProperty(module, \"id\", {\n\t\t\tenumerable: true,\n\t\t\tget: function() {\n\t\t\t\treturn module.i;\n\t\t\t}\n\t\t});\n\t\tObject.defineProperty(module, \"exports\", {\n\t\t\tenumerable: true\n\t\t});\n\t\tmodule.webpackPolyfill = 1;\n\t}\n\treturn module;\n};\n\n\n//# sourceURL=webpack:///(webpack)/buildin/harmony-module.js?");

/***/ })

}]);