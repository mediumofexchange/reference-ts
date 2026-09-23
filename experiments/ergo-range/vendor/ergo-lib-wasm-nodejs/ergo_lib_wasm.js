/* @ts-self-types="./ergo_lib_wasm.d.ts" */

/**
 *
 * * An address is a short string corresponding to some script used to protect a box. Unlike (string-encoded) binary
 * * representation of a script, an address has some useful characteristics:
 * *
 * * - Integrity of an address could be checked., as it is incorporating a checksum.
 * * - A prefix of address is showing network and an address type.
 * * - An address is using an encoding (namely, Base58) which is avoiding similarly l0Oking characters, friendly to
 * * double-clicking and line-breaking in emails.
 * *
 * *
 * *
 * * An address is encoding network type, address type, checksum, and enough information to watch for a particular scripts.
 * *
 * * Possible network types are:
 * * Mainnet - 0x00
 * * Testnet - 0x10
 * *
 * * For an address type, we form content bytes as follows:
 * *
 * * P2PK - serialized (compressed) public key
 * * P2SH - first 192 bits of the Blake2b256 hash of serialized script bytes
 * * P2S  - serialized script
 * *
 * * Address examples for testnet:
 * *
 * * 3   - P2PK (3WvsT2Gm4EpsM9Pg18PdY6XyhNNMqXDsvJTbbf6ihLvAmSb7u5RN)
 * * ?   - P2SH (rbcrmKEYduUvADj9Ts3dSVSG27h54pgrq5fPuwB)
 * * ?   - P2S (Ms7smJwLGbUAjuWQ)
 * *
 * * for mainnet:
 * *
 * * 9  - P2PK (9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA)
 * * ?  - P2SH (8UApt8czfFVuTgQmMwtsRBZ4nfWquNiSwCWUjMg)
 * * ?  - P2S (4MQyML64GnzMxZgm, BxKBaHkvrTvLZrDcZjcsxsF7aSsrN73ijeFZXtbj4CXZHHcvBtqSxQ)
 * *
 * *
 * * Prefix byte = network type + address type
 * *
 * * checksum = blake2b256(prefix byte ++ content bytes)
 * *
 * * address = prefix byte ++ content bytes ++ checksum
 * *
 *
 */
class Address {
    static __wrap(ptr) {
        const obj = Object.create(Address.prototype);
        obj.__wbg_ptr = ptr;
        AddressFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AddressFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_address_free(ptr, 0);
    }
    /**
     * Get the type of the address
     * @returns {AddressTypePrefix}
     */
    address_type_prefix() {
        const ret = wasm.address_address_type_prefix(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns underlying value for each address type
     * (serialized EcPoint for P2PK, stored bytes for P2SH and P2S)
     * @returns {Uint8Array}
     */
    content_bytes() {
        const ret = wasm.address_content_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Decode (base58) address from string without checking the network prefix
     * @param {string} s
     * @returns {Address}
     */
    static from_base58(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_from_base58(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Decode from a serialized address (that includes the network prefix)
     * @param {Uint8Array} data
     * @returns {Address}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Decode (base58) mainnet address from string, checking that address is from the mainnet
     * @param {string} s
     * @returns {Address}
     */
    static from_mainnet_str(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_from_mainnet_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Create an address from a public key
     * @param {Uint8Array} bytes
     * @returns {Address}
     */
    static from_public_key(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_from_public_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Decode (base58) testnet address from string, checking that address is from the testnet
     * @param {string} s
     * @returns {Address}
     */
    static from_testnet_str(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_from_testnet_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Create a P2PK address from serialized PK bytes(EcPoint/GroupElement)
     * @param {Uint8Array} bytes
     * @returns {Address}
     */
    static p2pk_from_pk_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.address_p2pk_from_pk_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Re-create the address from ErgoTree that was built from the address
     *
     * At some point in the past a user entered an address from which the ErgoTree was built.
     * Re-create the address from this ErgoTree.
     * `tree` - ErgoTree that was created from an Address
     * @param {ErgoTree} ergo_tree
     * @returns {Address}
     */
    static recreate_from_ergo_tree(ergo_tree) {
        _assertClass(ergo_tree, ErgoTree);
        const ret = wasm.address_recreate_from_ergo_tree(ergo_tree.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Address.__wrap(ret[0]);
    }
    /**
     * Encode (base58) address
     * @param {NetworkPrefix} network_prefix
     * @returns {string}
     */
    to_base58(network_prefix) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.address_to_base58(this.__wbg_ptr, network_prefix);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Encode address as serialized bytes (that includes the network prefix)
     * @param {NetworkPrefix} network_prefix
     * @returns {Uint8Array}
     */
    to_bytes(network_prefix) {
        const ret = wasm.address_to_bytes(this.__wbg_ptr, network_prefix);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Creates an ErgoTree script from the address
     * @returns {ErgoTree}
     */
    to_ergo_tree() {
        const ret = wasm.address_to_ergo_tree(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoTree.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Address.prototype[Symbol.dispose] = Address.prototype.free;
exports.Address = Address;

/**
 * Address types
 * @enum {1 | 2 | 3}
 */
const AddressTypePrefix = Object.freeze({
    /**
     * 0x01 - Pay-to-PublicKey(P2PK) address
     */
    P2Pk: 1, "1": "P2Pk",
    /**
     * 0x02 - Pay-to-Script-Hash(P2SH)
     */
    Pay2Sh: 2, "2": "Pay2Sh",
    /**
     * 0x03 - Pay-to-Script(P2S)
     */
    Pay2S: 3, "3": "Pay2S",
});
exports.AddressTypePrefix = AddressTypePrefix;

/**
 * BatchMerkleProof type to validate root hash for multiple nodes
 */
class BatchMerkleProof {
    static __wrap(ptr) {
        const obj = Object.create(BatchMerkleProof.prototype);
        obj.__wbg_ptr = ptr;
        BatchMerkleProofFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BatchMerkleProofFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_batchmerkleproof_free(ptr, 0);
    }
    /**
     * Creates a new [`BatchMerkleProof`] from json representation
     * @param {any} json
     * @returns {BatchMerkleProof}
     */
    static from_json(json) {
        const ret = wasm.batchmerkleproof_from_json(json);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BatchMerkleProof.__wrap(ret[0]);
    }
    /**
     * Converts [`BatchMerkleProof`] to json representation
     * @returns {any}
     */
    to_json() {
        const ret = wasm.batchmerkleproof_to_json(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Calculates root hash for [`BatchMerkleProof`] and compares it against expected root hash
     * @param {Uint8Array} expected_root
     * @returns {boolean}
     */
    valid(expected_root) {
        const ptr0 = passArray8ToWasm0(expected_root, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.batchmerkleproof_valid(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
}
if (Symbol.dispose) BatchMerkleProof.prototype[Symbol.dispose] = BatchMerkleProof.prototype.free;
exports.BatchMerkleProof = BatchMerkleProof;

/**
 * Block header
 */
class BlockHeader {
    static __wrap(ptr) {
        const obj = Object.create(BlockHeader.prototype);
        obj.__wbg_ptr = ptr;
        BlockHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlockHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blockheader_free(ptr, 0);
    }
    /**
     * Parse from JSON (Node API)
     * @param {string} json
     * @returns {BlockHeader}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blockheader_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BlockHeader.__wrap(ret[0]);
    }
    /**
     * Get Header's id
     * @returns {BlockId}
     */
    id() {
        const ret = wasm.blockheader_id(this.__wbg_ptr);
        return BlockId.__wrap(ret);
    }
    /**
     * Get transactions root
     * @returns {Uint8Array}
     */
    transactions_root() {
        const ret = wasm.blockheader_transactions_root(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) BlockHeader.prototype[Symbol.dispose] = BlockHeader.prototype.free;
exports.BlockHeader = BlockHeader;

/**
 * Collection of BlockHeaders
 */
class BlockHeaders {
    static __wrap(ptr) {
        const obj = Object.create(BlockHeaders.prototype);
        obj.__wbg_ptr = ptr;
        BlockHeadersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlockHeadersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blockheaders_free(ptr, 0);
    }
    /**
     * Add an element to the collection
     * @param {BlockHeader} b
     */
    add(b) {
        _assertClass(b, BlockHeader);
        wasm.blockheaders_add(this.__wbg_ptr, b.__wbg_ptr);
    }
    /**
     * parse BlockHeader array from JSON (Node API)
     * @param {any[]} json_vals
     * @returns {BlockHeaders}
     */
    static from_json(json_vals) {
        const ptr0 = passArrayJsValueToWasm0(json_vals, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blockheaders_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BlockHeaders.__wrap(ret[0]);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {BlockHeader}
     */
    get(index) {
        const ret = wasm.blockheaders_get(this.__wbg_ptr, index);
        return BlockHeader.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.blockheaders_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create new collection with one element
     * @param {BlockHeader} b
     */
    constructor(b) {
        _assertClass(b, BlockHeader);
        const ret = wasm.blockheaders_new(b.__wbg_ptr);
        this.__wbg_ptr = ret;
        BlockHeadersFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) BlockHeaders.prototype[Symbol.dispose] = BlockHeaders.prototype.free;
exports.BlockHeaders = BlockHeaders;

/**
 * Block id
 */
class BlockId {
    static __wrap(ptr) {
        const obj = Object.create(BlockId.prototype);
        obj.__wbg_ptr = ptr;
        BlockIdFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlockIdFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blockid_free(ptr, 0);
    }
    /**
     * Equality check
     * @param {BlockId} id
     * @returns {boolean}
     */
    equals(id) {
        _assertClass(id, BlockId);
        const ret = wasm.blockid_equals(this.__wbg_ptr, id.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Parse from base 16 encoded string
     * @param {string} id
     * @returns {BlockId}
     */
    static from_str(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blockid_from_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BlockId.__wrap(ret[0]);
    }
}
if (Symbol.dispose) BlockId.prototype[Symbol.dispose] = BlockId.prototype.free;
exports.BlockId = BlockId;

/**
 * Box id (32-byte digest)
 */
class BoxId {
    static __wrap(ptr) {
        const obj = Object.create(BoxId.prototype);
        obj.__wbg_ptr = ptr;
        BoxIdFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BoxIdFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boxid_free(ptr, 0);
    }
    /**
     * Returns byte array (32 bytes)
     * @returns {Uint8Array}
     */
    as_bytes() {
        const ret = wasm.boxid_as_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Parse box id (32 byte digest) from base16-encoded string
     * @param {string} box_id_str
     * @returns {BoxId}
     */
    static from_str(box_id_str) {
        const ptr0 = passStringToWasm0(box_id_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boxid_from_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BoxId.__wrap(ret[0]);
    }
    /**
     * Base16 encoded string
     * @returns {string}
     */
    to_str() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.boxid_to_str(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) BoxId.prototype[Symbol.dispose] = BoxId.prototype.free;
exports.BoxId = BoxId;

/**
 * Selected boxes with change boxes (by [`BoxSelector`])
 */
class BoxSelection {
    static __wrap(ptr) {
        const obj = Object.create(BoxSelection.prototype);
        obj.__wbg_ptr = ptr;
        BoxSelectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BoxSelectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boxselection_free(ptr, 0);
    }
    /**
     * Selected boxes to spend as transaction inputs
     * @returns {ErgoBoxes}
     */
    boxes() {
        const ret = wasm.boxselection_boxes(this.__wbg_ptr);
        return ErgoBoxes.__wrap(ret);
    }
    /**
     * Selected boxes to use as change
     * @returns {ErgoBoxAssetsDataList}
     */
    change() {
        const ret = wasm.boxselection_change(this.__wbg_ptr);
        return ErgoBoxAssetsDataList.__wrap(ret);
    }
    /**
     * Create a selection to easily inject custom selection algorithms
     * @param {ErgoBoxes} boxes
     * @param {ErgoBoxAssetsDataList} change
     */
    constructor(boxes, change) {
        _assertClass(boxes, ErgoBoxes);
        _assertClass(change, ErgoBoxAssetsDataList);
        const ret = wasm.boxselection_new(boxes.__wbg_ptr, change.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        BoxSelectionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) BoxSelection.prototype[Symbol.dispose] = BoxSelection.prototype.free;
exports.BoxSelection = BoxSelection;

/**
 * Box value in nanoERGs with bound checks
 */
class BoxValue {
    static __wrap(ptr) {
        const obj = Object.create(BoxValue.prototype);
        obj.__wbg_ptr = ptr;
        BoxValueFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BoxValueFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boxvalue_free(ptr, 0);
    }
    /**
     * Recommended (safe) minimal box value to use in case box size estimation is unavailable.
     * Allows box size upto 2777 bytes with current min box value per byte of 360 nanoERGs
     * @returns {BoxValue}
     */
    static SAFE_USER_MIN() {
        const ret = wasm.boxvalue_SAFE_USER_MIN();
        return BoxValue.__wrap(ret);
    }
    /**
     * Number of units inside one ERGO (i.e. one ERG using nano ERG representation)
     * @returns {I64}
     */
    static UNITS_PER_ERGO() {
        const ret = wasm.boxvalue_UNITS_PER_ERGO();
        return I64.__wrap(ret);
    }
    /**
     * Get value as signed 64-bit long (I64)
     * @returns {I64}
     */
    as_i64() {
        const ret = wasm.boxvalue_as_i64(this.__wbg_ptr);
        return I64.__wrap(ret);
    }
    /**
     * Create from i64 with bounds check
     * @param {I64} v
     * @returns {BoxValue}
     */
    static from_i64(v) {
        _assertClass(v, I64);
        const ret = wasm.boxvalue_from_i64(v.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BoxValue.__wrap(ret[0]);
    }
    /**
     * big-endian byte array representation
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.boxvalue_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) BoxValue.prototype[Symbol.dispose] = BoxValue.prototype.free;
exports.BoxValue = BoxValue;

/**
 * CommitmentHint
 */
class CommitmentHint {
    static __wrap(ptr) {
        const obj = Object.create(CommitmentHint.prototype);
        obj.__wbg_ptr = ptr;
        CommitmentHintFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CommitmentHintFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_commitmenthint_free(ptr, 0);
    }
}
if (Symbol.dispose) CommitmentHint.prototype[Symbol.dispose] = CommitmentHint.prototype.free;
exports.CommitmentHint = CommitmentHint;

/**
 * Ergo constant(evaluated) values
 */
class Constant {
    static __wrap(ptr) {
        const obj = Object.create(Constant.prototype);
        obj.__wbg_ptr = ptr;
        ConstantFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ConstantFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_constant_free(ptr, 0);
    }
    /**
     * Returns the debug representation of the value of the constant
     * @returns {string}
     */
    dbg_inner() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.constant_dbg_inner(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the debug representation of the type of the constant
     * @returns {string}
     */
    dbg_tpe() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.constant_dbg_tpe(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Decode from Base16-encoded ErgoTree serialized value
     * @param {string} base16_bytes_str
     * @returns {Constant}
     */
    static decode_from_base16(base16_bytes_str) {
        const ptr0 = passStringToWasm0(base16_bytes_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_decode_from_base16(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Encode as Base16-encoded ErgoTree serialized value or return an error if serialization
     * failed
     * @returns {string}
     */
    encode_to_base16() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.constant_encode_to_base16(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Create BigInt constant from byte array (signed bytes bit-endian)
     * @param {Uint8Array} num
     * @returns {Constant}
     */
    static from_bigint_signed_bytes_be(num) {
        const ptr0 = passArray8ToWasm0(num, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_bigint_signed_bytes_be(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Create from byte array
     * @param {Uint8Array} v
     * @returns {Constant}
     */
    static from_byte_array(v) {
        const ptr0 = passArray8ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_byte_array(ptr0, len0);
        return Constant.__wrap(ret);
    }
    /**
     * Create `Coll[Coll[Byte]]` from array byte array
     * @param {Uint8Array[]} arr
     * @returns {Constant}
     */
    static from_coll_coll_byte(arr) {
        const ptr0 = passArrayJsValueToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_coll_coll_byte(ptr0, len0);
        return Constant.__wrap(ret);
    }
    /**
     * Parse raw `EcPoint` value from bytes and make `ProveDlog` constant
     * @param {Uint8Array} bytes
     * @returns {Constant}
     */
    static from_ecpoint_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_ecpoint_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Parse raw `EcPoint` value from bytes and make `GroupElement` constant
     * @param {Uint8Array} bytes
     * @returns {Constant}
     */
    static from_ecpoint_bytes_group_element(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_ecpoint_bytes_group_element(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Create from ErgoBox value
     * @param {ErgoBox} v
     * @returns {Constant}
     */
    static from_ergo_box(v) {
        _assertClass(v, ErgoBox);
        const ret = wasm.constant_from_ergo_box(v.__wbg_ptr);
        return Constant.__wrap(ret);
    }
    /**
     * Create `Coll[Int]` from integer array
     * @param {Int32Array} arr
     * @returns {Constant}
     */
    static from_i32_array(arr) {
        const ptr0 = passArray32ToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_i32_array(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Create from i32 value
     * @param {number} v
     * @returns {Constant}
     */
    static from_i32(v) {
        const ret = wasm.constant_from_i32(v);
        return Constant.__wrap(ret);
    }
    /**
     * Create from i64
     * @param {I64} v
     * @returns {Constant}
     */
    static from_i64(v) {
        _assertClass(v, I64);
        const ret = wasm.constant_from_i64(v.__wbg_ptr);
        return Constant.__wrap(ret);
    }
    /**
     * Create `Coll[Long]` from string array
     * @param {any[]} arr
     * @returns {Constant}
     */
    static from_i64_str_array(arr) {
        const ptr0 = passArrayJsValueToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_i64_str_array(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Create a Constant from JS value
     * JS types are converted to the following Ergo types:
     * Number -> Int,
     * String -> Long,
     * BigInt -> BigInt,
     * use array_as_tuple() to encode Ergo tuples
     * @param {any} value
     * @returns {Constant}
     */
    static from_js(value) {
        const ret = wasm.constant_from_js(value);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Create `(Coll[Byte], Coll[Byte])` tuple Constant
     * @param {Uint8Array} bytes1
     * @param {Uint8Array} bytes2
     * @returns {Constant}
     */
    static from_tuple_coll_bytes(bytes1, bytes2) {
        const ptr0 = passArray8ToWasm0(bytes1, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes2, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.constant_from_tuple_coll_bytes(ptr0, len0, ptr1, len1);
        return Constant.__wrap(ret);
    }
    /**
     * Create `(Long, Long)` tuple Constant
     * @param {I64} l1
     * @param {I64} l2
     * @returns {Constant}
     */
    static from_tuple_i64(l1, l2) {
        _assertClass(l1, I64);
        _assertClass(l2, I64);
        const ret = wasm.constant_from_tuple_i64(l1.__wbg_ptr, l2.__wbg_ptr);
        return Constant.__wrap(ret);
    }
    /**
     * Create from UnsignedBigInt value
     * @param {UnsignedBigInt} v
     * @returns {Constant}
     */
    static from_u256(v) {
        _assertClass(v, UnsignedBigInt);
        const ret = wasm.constant_from_u256(v.__wbg_ptr);
        return Constant.__wrap(ret);
    }
    /**
     * Returns true if constant value is Unit
     * @returns {boolean}
     */
    is_unit() {
        const ret = wasm.constant_is_unit(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns serialized bytes or fails with error if Constant cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.constant_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Extract byte array, returning error if wrong type
     * @returns {Uint8Array}
     */
    to_byte_array() {
        const ret = wasm.constant_to_byte_array(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Extract `Coll[Coll[Byte]]` as array of byte arrays
     * @returns {Uint8Array[]}
     */
    to_coll_coll_byte() {
        const ret = wasm.constant_to_coll_coll_byte(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Extract ErgoBox value, returning error if wrong type
     * @returns {ErgoBox}
     */
    to_ergo_box() {
        const ret = wasm.constant_to_ergo_box(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBox.__wrap(ret[0]);
    }
    /**
     * Extract `Coll[Int]` as integer array
     * @returns {Int32Array}
     */
    to_i32_array() {
        const ret = wasm.constant_to_i32_array(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Extract i32 value, returning error if wrong type
     * @returns {number}
     */
    to_i32() {
        const ret = wasm.constant_to_i32(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Extract i64 value, returning error if wrong type
     * @returns {I64}
     */
    to_i64() {
        const ret = wasm.constant_to_i64(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return I64.__wrap(ret[0]);
    }
    /**
     * Extract `Coll[Long]` as string array
     * @returns {any[]}
     */
    to_i64_str_array() {
        const ret = wasm.constant_to_i64_str_array(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Extract JS value from Constant
     * Ergo types are converted to the following JS types:
     * Byte -> Number,
     * Short -> Number,
     * Int -> Number,
     * Long -> String,
     * BigInt -> BigInt,
     * Ergo tuples are encoded as arrays
     * @returns {any}
     */
    to_js() {
        const ret = wasm.constant_to_js(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Extract `(Coll[Byte], Coll[Byte])` tuple from Constant as array of Uint8Array
     * @returns {Uint8Array[]}
     */
    to_tuple_coll_bytes() {
        const ret = wasm.constant_to_tuple_coll_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Create `(Int, Int)` tuple Constant
     * @returns {any[]}
     */
    to_tuple_i32() {
        const ret = wasm.constant_to_tuple_i32(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Extract `(Long, Long)` tuple from Constant as array of strings
     * @returns {any[]}
     */
    to_tuple_i64() {
        const ret = wasm.constant_to_tuple_i64(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Create Constant with Unit value
     * @returns {Constant}
     */
    static unit() {
        const ret = wasm.constant_unit();
        return Constant.__wrap(ret);
    }
}
if (Symbol.dispose) Constant.prototype[Symbol.dispose] = Constant.prototype.free;
exports.Constant = Constant;

/**
 * User-defined variables to be put into context
 */
class ContextExtension {
    static __wrap(ptr) {
        const obj = Object.create(ContextExtension.prototype);
        obj.__wbg_ptr = ptr;
        ContextExtensionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ContextExtensionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_contextextension_free(ptr, 0);
    }
    /**
     * get from map or fail if key is missing
     * @param {number} key
     * @returns {Constant}
     */
    get(key) {
        const ret = wasm.contextextension_get(this.__wbg_ptr, key);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Constant.__wrap(ret[0]);
    }
    /**
     * Returns all keys in the map
     * @returns {Uint8Array}
     */
    keys() {
        const ret = wasm.contextextension_keys(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.contextextension_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create new ContextExtension instance
     */
    constructor() {
        const ret = wasm.contextextension_new();
        this.__wbg_ptr = ret;
        ContextExtensionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set the supplied pair in the ContextExtension
     * @param {number} id
     * @param {Constant} value
     */
    set_pair(id, value) {
        _assertClass(value, Constant);
        wasm.contextextension_set_pair(this.__wbg_ptr, id, value.__wbg_ptr);
    }
    /**
     * Returns serialized bytes or fails with error if ContextExtension cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.contextextension_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ContextExtension.prototype[Symbol.dispose] = ContextExtension.prototype.free;
exports.ContextExtension = ContextExtension;

/**
 * Defines the contract(script) that will be guarding box contents
 */
class Contract {
    static __wrap(ptr) {
        const obj = Object.create(Contract.prototype);
        obj.__wbg_ptr = ptr;
        ContractFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ContractFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_contract_free(ptr, 0);
    }
    /**
     * Get the ErgoTree of the contract
     * @returns {ErgoTree}
     */
    ergo_tree() {
        const ret = wasm.contract_ergo_tree(this.__wbg_ptr);
        return ErgoTree.__wrap(ret);
    }
    /**
     * Create new contract from ErgoTree
     * @param {ErgoTree} ergo_tree
     * @returns {Contract}
     */
    static new(ergo_tree) {
        _assertClass(ergo_tree, ErgoTree);
        var ptr0 = ergo_tree.__destroy_into_raw();
        const ret = wasm.contract_new(ptr0);
        return Contract.__wrap(ret);
    }
    /**
     * create new contract that allow spending of the guarded box by a given recipient ([`Address`])
     * @param {Address} recipient
     * @returns {Contract}
     */
    static pay_to_address(recipient) {
        _assertClass(recipient, Address);
        const ret = wasm.contract_pay_to_address(recipient.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Contract.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Contract.prototype[Symbol.dispose] = Contract.prototype.free;
exports.Contract = Contract;

/**
 * Inputs, that are used to enrich script context, but won't be spent by the transaction
 */
class DataInput {
    static __wrap(ptr) {
        const obj = Object.create(DataInput.prototype);
        obj.__wbg_ptr = ptr;
        DataInputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DataInputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_datainput_free(ptr, 0);
    }
    /**
     * Get box id
     * @returns {BoxId}
     */
    box_id() {
        const ret = wasm.datainput_box_id(this.__wbg_ptr);
        return BoxId.__wrap(ret);
    }
    /**
     * Parse box id (32 byte digest) from base16-encoded string
     * @param {BoxId} box_id
     */
    constructor(box_id) {
        _assertClass(box_id, BoxId);
        var ptr0 = box_id.__destroy_into_raw();
        const ret = wasm.datainput_new(ptr0);
        this.__wbg_ptr = ret;
        DataInputFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) DataInput.prototype[Symbol.dispose] = DataInput.prototype.free;
exports.DataInput = DataInput;

/**
 * DataInput collection
 */
class DataInputs {
    static __wrap(ptr) {
        const obj = Object.create(DataInputs.prototype);
        obj.__wbg_ptr = ptr;
        DataInputsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DataInputsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_datainputs_free(ptr, 0);
    }
    /**
     * Adds an elements to the collection
     * @param {DataInput} elem
     */
    add(elem) {
        _assertClass(elem, DataInput);
        wasm.datainputs_add(this.__wbg_ptr, elem.__wbg_ptr);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {DataInput}
     */
    get(index) {
        const ret = wasm.datainputs_get(this.__wbg_ptr, index);
        return DataInput.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.datainputs_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty DataInputs
     */
    constructor() {
        const ret = wasm.datainputs_new();
        this.__wbg_ptr = ret;
        DataInputsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) DataInputs.prototype[Symbol.dispose] = DataInputs.prototype.free;
exports.DataInputs = DataInputs;

/**
 * According to
 * BIP-44 <https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki>
 * and EIP-3 <https://github.com/ergoplatform/eips/blob/master/eip-0003.md>
 */
class DerivationPath {
    static __wrap(ptr) {
        const obj = Object.create(DerivationPath.prototype);
        obj.__wbg_ptr = ptr;
        DerivationPathFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DerivationPathFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_derivationpath_free(ptr, 0);
    }
    /**
     * Returns the length of the derivation path
     * @returns {number}
     */
    depth() {
        const ret = wasm.derivationpath_depth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a derivation path from a formatted string
     * E.g "m/44'/429'/0'/0/1"
     * @param {string} path
     * @returns {DerivationPath}
     */
    static from_string(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.derivationpath_from_string(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DerivationPath.__wrap(ret[0]);
    }
    /**
     * For 0x21 Sign Transaction command of Ergo Ledger App Protocol
     * P2PK Sign (0x0D) instruction
     * Sign calculated TX hash with private key for provided BIP44 path.
     * Data:
     *
     * Field
     * Size (B)
     * Description
     *
     * BIP32 path length
     * 1
     * Value: 0x02-0x0A (2-10). Number of path components
     *
     * First derivation index
     * 4
     * Big-endian. Value: 44’
     *
     * Second derivation index
     * 4
     * Big-endian. Value: 429’ (Ergo coin id)
     *
     * Optional Third index
     * 4
     * Big-endian. Any valid bip44 hardened value.
     * ...
     * Optional Last index
     * 4
     * Big-endian. Any valid bip44 value.
     * @returns {Uint8Array}
     */
    ledger_bytes() {
        const ret = wasm.derivationpath_ledger_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Create root derivation path
     * @returns {DerivationPath}
     */
    static master_path() {
        const ret = wasm.derivationpath_master_path();
        return DerivationPath.__wrap(ret);
    }
    /**
     * Create derivation path for a given account index (hardened) and address indices
     * `m / 44' / 429' / acc' / 0 / address[0] / address[1] / ...`
     * or `m / 44' / 429' / acc' / 0` if address indices are empty
     * change is always zero according to EIP-3
     * acc is expected as a 31-bit value (32th bit should not be set)
     * @param {number} acc
     * @param {Uint32Array} address_indices
     * @returns {DerivationPath}
     */
    static new(acc, address_indices) {
        const ptr0 = passArray32ToWasm0(address_indices, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.derivationpath_new(acc, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DerivationPath.__wrap(ret[0]);
    }
    /**
     * Returns a new path with the last element of the deriviation path being increased, e.g. m/1/2 -> m/1/3
     * Returns an empty path error if the path is empty (master node)
     * @returns {DerivationPath}
     */
    next() {
        const ret = wasm.derivationpath_next(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DerivationPath.__wrap(ret[0]);
    }
    /**
     * String representation of derivation path
     * E.g m/44'/429'/0'/0/1
     * @returns {string}
     */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.derivationpath_toString(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) DerivationPath.prototype[Symbol.dispose] = DerivationPath.prototype.free;
exports.DerivationPath = DerivationPath;

/**
 * Ergo box, that is taking part in some transaction on the chain
 * Differs with [`ErgoBoxCandidate`] by added transaction id and an index in the input of that transaction
 */
class ErgoBox {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBox.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergobox_free(ptr, 0);
    }
    /**
     * Get box id
     * @returns {BoxId}
     */
    box_id() {
        const ret = wasm.ergobox_box_id(this.__wbg_ptr);
        return BoxId.__wrap(ret);
    }
    /**
     * Get box creation height
     * @returns {number}
     */
    creation_height() {
        const ret = wasm.ergobox_creation_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get ergo tree for box
     * @returns {ErgoTree}
     */
    ergo_tree() {
        const ret = wasm.ergobox_ergo_tree(this.__wbg_ptr);
        return ErgoTree.__wrap(ret);
    }
    /**
     * Create ErgoBox from ErgoBoxCandidate by adding transaction id
     * and index of the box in the transaction
     * @param {ErgoBoxCandidate} candidate
     * @param {TxId} tx_id
     * @param {number} index
     * @returns {ErgoBox}
     */
    static from_box_candidate(candidate, tx_id, index) {
        _assertClass(candidate, ErgoBoxCandidate);
        _assertClass(tx_id, TxId);
        const ret = wasm.ergobox_from_box_candidate(candidate.__wbg_ptr, tx_id.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBox.__wrap(ret[0]);
    }
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     * @param {string} json
     * @returns {ErgoBox}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ergobox_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBox.__wrap(ret[0]);
    }
    /**
     * Index of this box in transaction outputs
     * @returns {number}
     */
    index() {
        const ret = wasm.ergobox_index(this.__wbg_ptr);
        return ret;
    }
    /**
     * make a new box with:
     * `value` - amount of money associated with the box
     * `contract` - guarding contract([`Contract`]), which should be evaluated to true in order
     * to open(spend) this box
     * `creation_height` - height when a transaction containing the box is created.
     * `tx_id` - transaction id in which this box was "created" (participated in outputs)
     * `index` - index (in outputs) in the transaction
     * @param {BoxValue} value
     * @param {number} creation_height
     * @param {Contract} contract
     * @param {TxId} tx_id
     * @param {number} index
     * @param {Tokens} tokens
     */
    constructor(value, creation_height, contract, tx_id, index, tokens) {
        _assertClass(value, BoxValue);
        _assertClass(contract, Contract);
        _assertClass(tx_id, TxId);
        _assertClass(tokens, Tokens);
        const ret = wasm.ergobox_new(value.__wbg_ptr, creation_height, contract.__wbg_ptr, tx_id.__wbg_ptr, index, tokens.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ErgoBoxFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns value (ErgoTree constant) stored in the register or None if the register is empty or cannot be parsed
     * @param {NonMandatoryRegisterId} register_id
     * @returns {Constant | undefined}
     */
    register_value(register_id) {
        const ret = wasm.ergobox_register_value(this.__wbg_ptr, register_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : Constant.__wrap(ret[0]);
    }
    /**
     * Serialized additional register as defined in ErgoBox serialization (registers count,
     * followed by every non-empyt register value serialized)
     * @returns {Uint8Array}
     */
    serialized_additional_registers() {
        const ret = wasm.ergobox_serialized_additional_registers(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Parses ErgoBox or fails with error
     * @param {Uint8Array} data
     * @returns {ErgoBox}
     */
    static sigma_parse_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ergobox_sigma_parse_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBox.__wrap(ret[0]);
    }
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.ergobox_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amounts encoding as strings)
     * @returns {any}
     */
    to_js_eip12() {
        const ret = wasm.ergobox_to_js_eip12(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.ergobox_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Get tokens for box
     * @returns {Tokens}
     */
    tokens() {
        const ret = wasm.ergobox_tokens(this.__wbg_ptr);
        return Tokens.__wrap(ret);
    }
    /**
     * Get id of transaction which created the box
     * @returns {TxId}
     */
    tx_id() {
        const ret = wasm.ergobox_tx_id(this.__wbg_ptr);
        return TxId.__wrap(ret);
    }
    /**
     * Get box value in nanoERGs
     * @returns {BoxValue}
     */
    value() {
        const ret = wasm.ergobox_value(this.__wbg_ptr);
        return BoxValue.__wrap(ret);
    }
}
if (Symbol.dispose) ErgoBox.prototype[Symbol.dispose] = ErgoBox.prototype.free;
exports.ErgoBox = ErgoBox;

/**
 * Pair of <value, tokens> for an box
 */
class ErgoBoxAssetsData {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBoxAssetsData.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxAssetsDataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxAssetsDataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxassetsdata_free(ptr, 0);
    }
    /**
     * Create new instance
     * @param {BoxValue} value
     * @param {Tokens} tokens
     */
    constructor(value, tokens) {
        _assertClass(value, BoxValue);
        _assertClass(tokens, Tokens);
        const ret = wasm.ergoboxassetsdata_new(value.__wbg_ptr, tokens.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ErgoBoxAssetsDataFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Tokens part of the box
     * @returns {Tokens}
     */
    tokens() {
        const ret = wasm.ergoboxassetsdata_tokens(this.__wbg_ptr);
        return Tokens.__wrap(ret);
    }
    /**
     * Value part of the box
     * @returns {BoxValue}
     */
    value() {
        const ret = wasm.ergoboxassetsdata_value(this.__wbg_ptr);
        return BoxValue.__wrap(ret);
    }
}
if (Symbol.dispose) ErgoBoxAssetsData.prototype[Symbol.dispose] = ErgoBoxAssetsData.prototype.free;
exports.ErgoBoxAssetsData = ErgoBoxAssetsData;

/**
 * List of asset data for a box
 */
class ErgoBoxAssetsDataList {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBoxAssetsDataList.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxAssetsDataListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxAssetsDataListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxassetsdatalist_free(ptr, 0);
    }
    /**
     * Adds an elements to the collection
     * @param {ErgoBoxAssetsData} elem
     */
    add(elem) {
        _assertClass(elem, ErgoBoxAssetsData);
        wasm.ergoboxassetsdatalist_add(this.__wbg_ptr, elem.__wbg_ptr);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {ErgoBoxAssetsData}
     */
    get(index) {
        const ret = wasm.ergoboxassetsdatalist_get(this.__wbg_ptr, index);
        return ErgoBoxAssetsData.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.ergoboxassetsdatalist_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty Tokens
     */
    constructor() {
        const ret = wasm.ergoboxassetsdatalist_new();
        this.__wbg_ptr = ret;
        ErgoBoxAssetsDataListFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ErgoBoxAssetsDataList.prototype[Symbol.dispose] = ErgoBoxAssetsDataList.prototype.free;
exports.ErgoBoxAssetsDataList = ErgoBoxAssetsDataList;

/**
 * ErgoBox candidate not yet included in any transaction on the chain
 */
class ErgoBoxCandidate {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBoxCandidate.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxCandidateFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxCandidateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxcandidate_free(ptr, 0);
    }
    /**
     * Get box creation height
     * @returns {number}
     */
    creation_height() {
        const ret = wasm.ergoboxcandidate_creation_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get ergo tree for box
     * @returns {ErgoTree}
     */
    ergo_tree() {
        const ret = wasm.ergoboxcandidate_ergo_tree(this.__wbg_ptr);
        return ErgoTree.__wrap(ret);
    }
    /**
     * Create a box with miner's contract and given value
     * @param {BoxValue} fee_amount
     * @param {number} creation_height
     * @returns {ErgoBoxCandidate}
     */
    static new_miner_fee_box(fee_amount, creation_height) {
        _assertClass(fee_amount, BoxValue);
        const ret = wasm.ergoboxcandidate_new_miner_fee_box(fee_amount.__wbg_ptr, creation_height);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBoxCandidate.__wrap(ret[0]);
    }
    /**
     * Returns value (ErgoTree constant) stored in the register or None if the register is empty or cannot be parsed
     * @param {NonMandatoryRegisterId} register_id
     * @returns {Constant | undefined}
     */
    register_value(register_id) {
        const ret = wasm.ergoboxcandidate_register_value(this.__wbg_ptr, register_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : Constant.__wrap(ret[0]);
    }
    /**
     * Serialized additional register as defined in ErgoBox serialization (registers count,
     * followed by every non-empyt register value serialized)
     * @returns {Uint8Array}
     */
    serialized_additional_registers() {
        const ret = wasm.ergoboxcandidate_serialized_additional_registers(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get tokens for box
     * @returns {Tokens}
     */
    tokens() {
        const ret = wasm.ergoboxcandidate_tokens(this.__wbg_ptr);
        return Tokens.__wrap(ret);
    }
    /**
     * Get box value in nanoERGs
     * @returns {BoxValue}
     */
    value() {
        const ret = wasm.ergoboxcandidate_value(this.__wbg_ptr);
        return BoxValue.__wrap(ret);
    }
}
if (Symbol.dispose) ErgoBoxCandidate.prototype[Symbol.dispose] = ErgoBoxCandidate.prototype.free;
exports.ErgoBoxCandidate = ErgoBoxCandidate;

/**
 * ErgoBoxCandidate builder
 */
class ErgoBoxCandidateBuilder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxCandidateBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxcandidatebuilder_free(ptr, 0);
    }
    /**
     * Add given token id and token amount
     * @param {TokenId} token_id
     * @param {TokenAmount} amount
     */
    add_token(token_id, amount) {
        _assertClass(token_id, TokenId);
        _assertClass(amount, TokenAmount);
        wasm.ergoboxcandidatebuilder_add_token(this.__wbg_ptr, token_id.__wbg_ptr, amount.__wbg_ptr);
    }
    /**
     * Build the box candidate
     * @returns {ErgoBoxCandidate}
     */
    build() {
        const ret = wasm.ergoboxcandidatebuilder_build(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBoxCandidate.__wrap(ret[0]);
    }
    /**
     * Calculate serialized box size(in bytes)
     * @returns {number}
     */
    calc_box_size_bytes() {
        const ret = wasm.ergoboxcandidatebuilder_calc_box_size_bytes(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Calculate minimal box value for the current box serialized size(in bytes)
     * @returns {BoxValue}
     */
    calc_min_box_value() {
        const ret = wasm.ergoboxcandidatebuilder_calc_min_box_value(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BoxValue.__wrap(ret[0]);
    }
    /**
     * Delete register value(make register empty) for the given register id (R4-R9)
     * @param {NonMandatoryRegisterId} register_id
     */
    delete_register_value(register_id) {
        wasm.ergoboxcandidatebuilder_delete_register_value(this.__wbg_ptr, register_id);
    }
    /**
     * Get minimal value (per byte of the serialized box size)
     * @returns {number}
     */
    min_box_value_per_byte() {
        const ret = wasm.ergoboxcandidatebuilder_min_box_value_per_byte(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Mint token, as defined in <https://github.com/ergoplatform/eips/blob/master/eip-0004.md>
     * `token` - token id(box id of the first input box in transaction) and token amount,
     * `token_name` - token name (will be encoded in R4),
     * `token_desc` - token description (will be encoded in R5),
     * `num_decimals` - number of decimals (will be encoded in R6)
     * @param {Token} token
     * @param {string} token_name
     * @param {string} token_desc
     * @param {number} num_decimals
     */
    mint_token(token, token_name, token_desc, num_decimals) {
        _assertClass(token, Token);
        const ptr0 = passStringToWasm0(token_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(token_desc, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.ergoboxcandidatebuilder_mint_token(this.__wbg_ptr, token.__wbg_ptr, ptr0, len0, ptr1, len1, num_decimals);
    }
    /**
     * Create builder with required box parameters:
     * `value` - amount of money associated with the box
     * `contract` - guarding contract([`Contract`]), which should be evaluated to true in order
     * to open(spend) this box
     * `creation_height` - height when a transaction containing the box is created.
     * It should not exceed height of the block, containing the transaction with this box.
     * @param {BoxValue} value
     * @param {Contract} contract
     * @param {number} creation_height
     */
    constructor(value, contract, creation_height) {
        _assertClass(value, BoxValue);
        _assertClass(contract, Contract);
        const ret = wasm.ergoboxcandidatebuilder_new(value.__wbg_ptr, contract.__wbg_ptr, creation_height);
        this.__wbg_ptr = ret;
        ErgoBoxCandidateBuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns register value for the given register id (R4-R9), or None if the register is empty
     * @param {NonMandatoryRegisterId} register_id
     * @returns {Constant | undefined}
     */
    register_value(register_id) {
        const ret = wasm.ergoboxcandidatebuilder_register_value(this.__wbg_ptr, register_id);
        return ret === 0 ? undefined : Constant.__wrap(ret);
    }
    /**
     * Set minimal value (per byte of the serialized box size)
     * @param {number} new_min_value_per_byte
     */
    set_min_box_value_per_byte(new_min_value_per_byte) {
        wasm.ergoboxcandidatebuilder_set_min_box_value_per_byte(this.__wbg_ptr, new_min_value_per_byte);
    }
    /**
     * Set register with a given id (R4-R9) to the given value
     * @param {NonMandatoryRegisterId} register_id
     * @param {Constant} value
     */
    set_register_value(register_id, value) {
        _assertClass(value, Constant);
        wasm.ergoboxcandidatebuilder_set_register_value(this.__wbg_ptr, register_id, value.__wbg_ptr);
    }
    /**
     * Set new box value
     * @param {BoxValue} new_value
     */
    set_value(new_value) {
        _assertClass(new_value, BoxValue);
        var ptr0 = new_value.__destroy_into_raw();
        wasm.ergoboxcandidatebuilder_set_value(this.__wbg_ptr, ptr0);
    }
    /**
     * Get box value
     * @returns {BoxValue}
     */
    value() {
        const ret = wasm.ergoboxcandidatebuilder_value(this.__wbg_ptr);
        return BoxValue.__wrap(ret);
    }
}
if (Symbol.dispose) ErgoBoxCandidateBuilder.prototype[Symbol.dispose] = ErgoBoxCandidateBuilder.prototype.free;
exports.ErgoBoxCandidateBuilder = ErgoBoxCandidateBuilder;

/**
 * Collection of ErgoBoxCandidates
 */
class ErgoBoxCandidates {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBoxCandidates.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxCandidatesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxCandidatesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxcandidates_free(ptr, 0);
    }
    /**
     * Add an element to the collection
     * @param {ErgoBoxCandidate} b
     */
    add(b) {
        _assertClass(b, ErgoBoxCandidate);
        wasm.ergoboxcandidates_add(this.__wbg_ptr, b.__wbg_ptr);
    }
    /**
     * sometimes it's useful to keep track of an empty list
     * but keep in mind Ergo transactions need at least 1 output
     * @returns {ErgoBoxCandidates}
     */
    static empty() {
        const ret = wasm.ergoboxcandidates_empty();
        return ErgoBoxCandidates.__wrap(ret);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {ErgoBoxCandidate}
     */
    get(index) {
        const ret = wasm.ergoboxcandidates_get(this.__wbg_ptr, index);
        return ErgoBoxCandidate.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.ergoboxcandidates_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create new outputs
     * @param {ErgoBoxCandidate} box_candidate
     */
    constructor(box_candidate) {
        _assertClass(box_candidate, ErgoBoxCandidate);
        const ret = wasm.ergoboxcandidates_new(box_candidate.__wbg_ptr);
        this.__wbg_ptr = ret;
        ErgoBoxCandidatesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ErgoBoxCandidates.prototype[Symbol.dispose] = ErgoBoxCandidates.prototype.free;
exports.ErgoBoxCandidates = ErgoBoxCandidates;

/**
 * Collection of ErgoBox'es
 */
class ErgoBoxes {
    static __wrap(ptr) {
        const obj = Object.create(ErgoBoxes.prototype);
        obj.__wbg_ptr = ptr;
        ErgoBoxesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoBoxesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergoboxes_free(ptr, 0);
    }
    /**
     * Add an element to the collection
     * @param {ErgoBox} b
     */
    add(b) {
        _assertClass(b, ErgoBox);
        wasm.ergoboxes_add(this.__wbg_ptr, b.__wbg_ptr);
    }
    /**
     * Empty ErgoBoxes
     * @returns {ErgoBoxes}
     */
    static empty() {
        const ret = wasm.ergoboxes_empty();
        return ErgoBoxes.__wrap(ret);
    }
    /**
     * parse ErgoBox array from json
     * @param {any[]} json_vals
     * @returns {ErgoBoxes}
     */
    static from_boxes_json(json_vals) {
        const ptr0 = passArrayJsValueToWasm0(json_vals, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ergoboxes_from_boxes_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoBoxes.__wrap(ret[0]);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {ErgoBox}
     */
    get(index) {
        const ret = wasm.ergoboxes_get(this.__wbg_ptr, index);
        return ErgoBox.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.ergoboxes_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create new collection with one element
     * @param {ErgoBox} b
     */
    constructor(b) {
        _assertClass(b, ErgoBox);
        const ret = wasm.ergoboxes_new(b.__wbg_ptr);
        this.__wbg_ptr = ret;
        ErgoBoxesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ErgoBoxes.prototype[Symbol.dispose] = ErgoBoxes.prototype.free;
exports.ErgoBoxes = ErgoBoxes;

/**
 * Blockchain state (last headers, etc.)
 */
class ErgoStateContext {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoStateContextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergostatecontext_free(ptr, 0);
    }
    /**
     * Create new context from pre-header
     * @param {PreHeader} pre_header
     * @param {BlockHeaders} headers
     * @param {Parameters} parameters
     */
    constructor(pre_header, headers, parameters) {
        _assertClass(pre_header, PreHeader);
        var ptr0 = pre_header.__destroy_into_raw();
        _assertClass(headers, BlockHeaders);
        var ptr1 = headers.__destroy_into_raw();
        _assertClass(parameters, Parameters);
        var ptr2 = parameters.__destroy_into_raw();
        const ret = wasm.ergostatecontext_new(ptr0, ptr1, ptr2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ErgoStateContextFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ErgoStateContext.prototype[Symbol.dispose] = ErgoStateContext.prototype.free;
exports.ErgoStateContext = ErgoStateContext;

/**
 * The root of ErgoScript IR. Serialized instances of this class are self sufficient and can be passed around.
 */
class ErgoTree {
    static __wrap(ptr) {
        const obj = Object.create(ErgoTree.prototype);
        obj.__wbg_ptr = ptr;
        ErgoTreeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ErgoTreeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ergotree_free(ptr, 0);
    }
    /**
     * Returns constants number as stored in serialized ErgoTree or error if the parsing of
     * constants is failed
     * @returns {number}
     */
    constants_len() {
        const ret = wasm.ergotree_constants_len(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Decode from base16 encoded serialized ErgoTree
     * @param {string} s
     * @returns {ErgoTree}
     */
    static from_base16_bytes(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ergotree_from_base16_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoTree.__wrap(ret[0]);
    }
    /**
     * Decode from encoded serialized ErgoTree
     * @param {Uint8Array} data
     * @returns {ErgoTree}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ergotree_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoTree.__wrap(ret[0]);
    }
    /**
     * Returns constant with given index (as stored in serialized ErgoTree)
     * or None if index is out of bounds
     * or error if constants parsing were failed
     * @param {number} index
     * @returns {Constant | undefined}
     */
    get_constant(index) {
        const ret = wasm.ergotree_get_constant(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : Constant.__wrap(ret[0]);
    }
    /**
     * Returns pretty printed tree
     * @returns {string}
     */
    pretty_print() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.ergotree_pretty_print(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns serialized bytes or fails with error if ErgoTree cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.ergotree_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Serialized proposition expression of SigmaProp type with
     * ConstantPlaceholder nodes instead of Constant nodes
     * @returns {Uint8Array}
     */
    template_bytes() {
        const ret = wasm.ergotree_template_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Returns Base16-encoded serialized bytes
     * @returns {string}
     */
    to_base16_bytes() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.ergotree_to_base16_bytes(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Consumes the calling ErgoTree and returns new ErgoTree with a new constant value
     * for a given index in constants list (as stored in serialized ErgoTree), or an error.
     * After the call the calling ErgoTree will be null.
     * @param {number} index
     * @param {Constant} constant
     * @returns {ErgoTree}
     */
    with_constant(index, constant) {
        const ptr = this.__destroy_into_raw();
        _assertClass(constant, Constant);
        const ret = wasm.ergotree_with_constant(ptr, index, constant.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ErgoTree.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ErgoTree.prototype[Symbol.dispose] = ErgoTree.prototype.free;
exports.ErgoTree = ErgoTree;

/**
 * Extented public key implemented according to BIP-32
 */
class ExtPubKey {
    static __wrap(ptr) {
        const obj = Object.create(ExtPubKey.prototype);
        obj.__wbg_ptr = ptr;
        ExtPubKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExtPubKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_extpubkey_free(ptr, 0);
    }
    /**
     * Chain code of the `ExtPubKey`
     * @returns {Uint8Array}
     */
    chain_code() {
        const ret = wasm.extpubkey_chain_code(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Soft derivation of the child public key with a given index
     * index is expected to be a 31-bit value(32th bit should not be set)
     * @param {number} index
     * @returns {ExtPubKey}
     */
    child(index) {
        const ret = wasm.extpubkey_child(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtPubKey.__wrap(ret[0]);
    }
    /**
     * Derive a new extended pub key from the derivation path
     * @param {DerivationPath} path
     * @returns {ExtPubKey}
     */
    derive(path) {
        _assertClass(path, DerivationPath);
        var ptr0 = path.__destroy_into_raw();
        const ret = wasm.extpubkey_derive(this.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtPubKey.__wrap(ret[0]);
    }
    /**
     * Create ExtPubKey from public key bytes (from SEC1 compressed), chain code and derivation
     * path
     * @param {Uint8Array} public_key_bytes
     * @param {Uint8Array} chain_code
     * @param {DerivationPath} derivation_path
     * @returns {ExtPubKey}
     */
    static new(public_key_bytes, chain_code, derivation_path) {
        const ptr0 = passArray8ToWasm0(public_key_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(chain_code, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(derivation_path, DerivationPath);
        const ret = wasm.extpubkey_new(ptr0, len0, ptr1, len1, derivation_path.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtPubKey.__wrap(ret[0]);
    }
    /**
     * Public key bytes of the `ExtPubKey`
     * @returns {Uint8Array}
     */
    pub_key_bytes() {
        const ret = wasm.extpubkey_pub_key_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Create address (P2PK) from this extended public key
     * @returns {Address}
     */
    to_address() {
        const ret = wasm.extpubkey_to_address(this.__wbg_ptr);
        return Address.__wrap(ret);
    }
}
if (Symbol.dispose) ExtPubKey.prototype[Symbol.dispose] = ExtPubKey.prototype.free;
exports.ExtPubKey = ExtPubKey;

/**
 * Extented secret key implemented according to BIP-32
 */
class ExtSecretKey {
    static __wrap(ptr) {
        const obj = Object.create(ExtSecretKey.prototype);
        obj.__wbg_ptr = ptr;
        ExtSecretKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExtSecretKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_extsecretkey_free(ptr, 0);
    }
    /**
     * Derive a new extended secret key from the provided index
     * The index is in the form of soft or hardened indices
     * For example: 4 or 4' respectively
     * @param {string} index
     * @returns {ExtSecretKey}
     */
    child(index) {
        const ptr0 = passStringToWasm0(index, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.extsecretkey_child(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtSecretKey.__wrap(ret[0]);
    }
    /**
     * Derive a new extended secret key from the derivation path
     * @param {DerivationPath} path
     * @returns {ExtSecretKey}
     */
    derive(path) {
        _assertClass(path, DerivationPath);
        var ptr0 = path.__destroy_into_raw();
        const ret = wasm.extsecretkey_derive(this.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtSecretKey.__wrap(ret[0]);
    }
    /**
     * Derive root extended secret key
     * @param {Uint8Array} seed_bytes
     * @returns {ExtSecretKey}
     */
    static derive_master(seed_bytes) {
        const ptr0 = passArray8ToWasm0(seed_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.extsecretkey_derive_master(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtSecretKey.__wrap(ret[0]);
    }
    /**
     * Create ExtSecretKey from secret key bytes, chain code and derivation path
     * @param {Uint8Array} secret_key_bytes
     * @param {Uint8Array} chain_code
     * @param {DerivationPath} derivation_path
     * @returns {ExtSecretKey}
     */
    static new(secret_key_bytes, chain_code, derivation_path) {
        const ptr0 = passArray8ToWasm0(secret_key_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(chain_code, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(derivation_path, DerivationPath);
        const ret = wasm.extsecretkey_new(ptr0, len0, ptr1, len1, derivation_path.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtSecretKey.__wrap(ret[0]);
    }
    /**
     * Derivation path associated with the ext secret key
     * @returns {DerivationPath}
     */
    path() {
        const ret = wasm.extsecretkey_path(this.__wbg_ptr);
        return DerivationPath.__wrap(ret);
    }
    /**
     * The extended public key associated with this secret key
     * @returns {ExtPubKey}
     */
    public_key() {
        const ret = wasm.extsecretkey_public_key(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ExtPubKey.__wrap(ret[0]);
    }
    /**
     * The bytes of the associated secret key
     * @returns {Uint8Array}
     */
    secret_key_bytes() {
        const ret = wasm.extsecretkey_secret_key_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ExtSecretKey.prototype[Symbol.dispose] = ExtSecretKey.prototype.free;
exports.ExtSecretKey = ExtSecretKey;

/**
 * HintsBag
 */
class HintsBag {
    static __wrap(ptr) {
        const obj = Object.create(HintsBag.prototype);
        obj.__wbg_ptr = ptr;
        HintsBagFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HintsBagFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hintsbag_free(ptr, 0);
    }
    /**
     * Add commitment hint to the bag
     * @param {CommitmentHint} hint
     */
    add_commitment(hint) {
        _assertClass(hint, CommitmentHint);
        var ptr0 = hint.__destroy_into_raw();
        wasm.hintsbag_add_commitment(this.__wbg_ptr, ptr0);
    }
    /**
     * Empty HintsBag
     * @returns {HintsBag}
     */
    static empty() {
        const ret = wasm.hintsbag_empty();
        return HintsBag.__wrap(ret);
    }
    /**
     * Get commitment
     * @param {number} index
     * @returns {CommitmentHint}
     */
    get(index) {
        const ret = wasm.hintsbag_get(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommitmentHint.__wrap(ret[0]);
    }
    /**
     * Length of HintsBag
     * @returns {number}
     */
    len() {
        const ret = wasm.hintsbag_len(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) HintsBag.prototype[Symbol.dispose] = HintsBag.prototype.free;
exports.HintsBag = HintsBag;

/**
 * Wrapper for i64 for JS/TS because JS Number can only represent 53 bits
 * see <https://stackoverflow.com/questions/17320706/javascript-long-integer>
 */
class I64 {
    static __wrap(ptr) {
        const obj = Object.create(I64.prototype);
        obj.__wbg_ptr = ptr;
        I64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        I64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_i64_free(ptr, 0);
    }
    /**
     * Get the value as JS number (64-bit float)
     * @returns {number}
     */
    as_num() {
        const ret = wasm.i64_as_num(this.__wbg_ptr);
        return ret;
    }
    /**
     * Addition with overflow check
     * @param {I64} other
     * @returns {I64}
     */
    checked_add(other) {
        _assertClass(other, I64);
        const ret = wasm.i64_checked_add(this.__wbg_ptr, other.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return I64.__wrap(ret[0]);
    }
    /**
     * Create from a standard rust string representation
     * @param {string} string
     * @returns {I64}
     */
    static from_str(string) {
        const ptr0 = passStringToWasm0(string, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.i64_from_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return I64.__wrap(ret[0]);
    }
    /**
     * String representation of the value for use from environments that don't support i64
     * @returns {string}
     */
    to_str() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.i64_to_str(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) I64.prototype[Symbol.dispose] = I64.prototype.free;
exports.I64 = I64;

/**
 * Signed inputs used in signed transactions
 */
class Input {
    static __wrap(ptr) {
        const obj = Object.create(Input.prototype);
        obj.__wbg_ptr = ptr;
        InputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_input_free(ptr, 0);
    }
    /**
     * Get box id
     * @returns {BoxId}
     */
    box_id() {
        const ret = wasm.input_box_id(this.__wbg_ptr);
        return BoxId.__wrap(ret);
    }
    /**
     * Get the spending proof
     * @returns {ProverResult}
     */
    spending_proof() {
        const ret = wasm.input_spending_proof(this.__wbg_ptr);
        return ProverResult.__wrap(ret);
    }
}
if (Symbol.dispose) Input.prototype[Symbol.dispose] = Input.prototype.free;
exports.Input = Input;

/**
 * Collection of signed inputs
 */
class Inputs {
    static __wrap(ptr) {
        const obj = Object.create(Inputs.prototype);
        obj.__wbg_ptr = ptr;
        InputsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InputsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inputs_free(ptr, 0);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {Input}
     */
    get(index) {
        const ret = wasm.inputs_get(this.__wbg_ptr, index);
        return Input.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.inputs_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty Inputs
     */
    constructor() {
        const ret = wasm.inputs_new();
        this.__wbg_ptr = ret;
        InputsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Inputs.prototype[Symbol.dispose] = Inputs.prototype.free;
exports.Inputs = Inputs;

/**
 * A level node in a merkle proof
 */
class LevelNode {
    static __wrap(ptr) {
        const obj = Object.create(LevelNode.prototype);
        obj.__wbg_ptr = ptr;
        LevelNodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LevelNodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_levelnode_free(ptr, 0);
    }
    /**
     * Returns the associated digest (hash) with this node. Returns an empty array if there's no hash
     * @returns {Uint8Array}
     */
    get digest() {
        const ret = wasm.levelnode_digest(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Creates a new LevelNode from a 32 byte hash and side that the node belongs on in the tree. Fails if the digest is not 32 bytes
     * @param {Uint8Array} hash
     * @param {number} side
     * @returns {LevelNode}
     */
    static new(hash, side) {
        const ptr0 = passArray8ToWasm0(hash, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.levelnode_new(ptr0, len0, side);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return LevelNode.__wrap(ret[0]);
    }
    /**
     * Returns the associated side with this node (0 = Left, 1 = Right)
     * @returns {number}
     */
    get side() {
        const ret = wasm.levelnode_side(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) LevelNode.prototype[Symbol.dispose] = LevelNode.prototype.free;
exports.LevelNode = LevelNode;

/**
 * A MerkleProof type. Given leaf data and levels (bottom-upwards), the root hash can be computed and validated
 */
class MerkleProof {
    static __wrap(ptr) {
        const obj = Object.create(MerkleProof.prototype);
        obj.__wbg_ptr = ptr;
        MerkleProofFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MerkleProofFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_merkleproof_free(ptr, 0);
    }
    /**
     * Adds a new node to the MerkleProof above the current nodes
     * @param {LevelNode} level
     */
    add_node(level) {
        _assertClass(level, LevelNode);
        wasm.merkleproof_add_node(this.__wbg_ptr, level.__wbg_ptr);
    }
    /**
     * Creates a new merkle proof with given leaf data and level data (bottom-upwards)
     * You can verify it against a Blakeb256 root hash by using [`Self::valid()`]
     * Add a node by using [`Self::add_node()`]
     * Each digest on the level must be exactly 32 bytes
     * @param {Uint8Array} leaf_data
     * @returns {MerkleProof}
     */
    static new(leaf_data) {
        const ptr0 = passArray8ToWasm0(leaf_data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.merkleproof_new(ptr0, len0);
        return MerkleProof.__wrap(ret);
    }
    /**
     * Validates the Merkle proof against the root hash
     * @param {Uint8Array} expected_root
     * @returns {boolean}
     */
    valid(expected_root) {
        const ptr0 = passArray8ToWasm0(expected_root, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.merkleproof_valid(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
}
if (Symbol.dispose) MerkleProof.prototype[Symbol.dispose] = MerkleProof.prototype.free;
exports.MerkleProof = MerkleProof;

/**
 * helper methods to get the fee address for various networks
 */
class MinerAddress {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MinerAddressFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mineraddress_free(ptr, 0);
    }
    /**
     * Miner fee Base58 encoded P2S address on mainnet
     * @returns {string}
     */
    static mainnet_fee_address() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.mineraddress_mainnet_fee_address();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Miner fee Base58 encoded P2S address on testnet
     * @returns {string}
     */
    static testnet_fee_address() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.mineraddress_testnet_fee_address();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) MinerAddress.prototype[Symbol.dispose] = MinerAddress.prototype.free;
exports.MinerAddress = MinerAddress;

/**
 * Mnemonic
 */
class Mnemonic {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MnemonicFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mnemonic_free(ptr, 0);
    }
    /**
     * Convert a mnemonic phrase into a mnemonic seed
     * mnemonic_pass is optional and is used to salt the seed
     * @param {string} mnemonic_phrase
     * @param {string} mnemonic_pass
     * @returns {Uint8Array}
     */
    static to_seed(mnemonic_phrase, mnemonic_pass) {
        const ptr0 = passStringToWasm0(mnemonic_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mnemonic_pass, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.mnemonic_to_seed(ptr0, len0, ptr1, len1);
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
}
if (Symbol.dispose) Mnemonic.prototype[Symbol.dispose] = Mnemonic.prototype.free;
exports.Mnemonic = Mnemonic;

/**
 * Combination of an Address with a network
 * These two combined together form a base58 encoding
 */
class NetworkAddress {
    static __wrap(ptr) {
        const obj = Object.create(NetworkAddress.prototype);
        obj.__wbg_ptr = ptr;
        NetworkAddressFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NetworkAddressFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_networkaddress_free(ptr, 0);
    }
    /**
     * Get address without network information
     * @returns {Address}
     */
    address() {
        const ret = wasm.networkaddress_address(this.__wbg_ptr);
        return Address.__wrap(ret);
    }
    /**
     * Decode (base58) a NetworkAddress (address + network prefix) from string
     * @param {string} s
     * @returns {NetworkAddress}
     */
    static from_base58(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.networkaddress_from_base58(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return NetworkAddress.__wrap(ret[0]);
    }
    /**
     * Decode from a serialized address
     * @param {Uint8Array} data
     * @returns {NetworkAddress}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.networkaddress_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return NetworkAddress.__wrap(ret[0]);
    }
    /**
     * Network for the address
     * @returns {NetworkPrefix}
     */
    network() {
        const ret = wasm.networkaddress_network(this.__wbg_ptr);
        return ret;
    }
    /**
     * create a new NetworkAddress(address + network prefix) for a given network type
     * @param {NetworkPrefix} network
     * @param {Address} address
     * @returns {NetworkAddress}
     */
    static new(network, address) {
        _assertClass(address, Address);
        const ret = wasm.networkaddress_new(network, address.__wbg_ptr);
        return NetworkAddress.__wrap(ret);
    }
    /**
     * Encode (base58) address
     * @returns {string}
     */
    to_base58() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.networkaddress_to_base58(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Encode address as serialized bytes
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.networkaddress_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) NetworkAddress.prototype[Symbol.dispose] = NetworkAddress.prototype.free;
exports.NetworkAddress = NetworkAddress;

/**
 * Network type
 * @enum {0 | 16}
 */
const NetworkPrefix = Object.freeze({
    /**
     * Mainnet
     */
    Mainnet: 0, "0": "Mainnet",
    /**
     * Testnet
     */
    Testnet: 16, "16": "Testnet",
});
exports.NetworkPrefix = NetworkPrefix;

/**
 * A structure representing NiPoPow proof.
 */
class NipopowProof {
    static __wrap(ptr) {
        const obj = Object.create(NipopowProof.prototype);
        obj.__wbg_ptr = ptr;
        NipopowProofFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NipopowProofFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_nipopowproof_free(ptr, 0);
    }
    /**
     * Parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     * @param {string} json
     * @returns {NipopowProof}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.nipopowproof_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return NipopowProof.__wrap(ret[0]);
    }
    /**
     * Implementation of the ≥ algorithm from [`KMZ17`], see Algorithm 4
     *
     * [`KMZ17`]: https://fc20.ifca.ai/preproceedings/74.pdf
     * @param {NipopowProof} that
     * @returns {boolean}
     */
    is_better_than(that) {
        _assertClass(that, NipopowProof);
        const ret = wasm.nipopowproof_is_better_than(this.__wbg_ptr, that.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Get suffix head
     * @returns {PoPowHeader}
     */
    suffix_head() {
        const ret = wasm.nipopowproof_suffix_head(this.__wbg_ptr);
        return PoPowHeader.__wrap(ret);
    }
    /**
     * JSON representation as text
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.nipopowproof_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) NipopowProof.prototype[Symbol.dispose] = NipopowProof.prototype.free;
exports.NipopowProof = NipopowProof;

/**
 * A verifier for PoPoW proofs. During its lifetime, it processes many proofs with the aim of
 * deducing at any given point what is the best (sub)chain rooted at the specified genesis.
 */
class NipopowVerifier {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NipopowVerifierFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_nipopowverifier_free(ptr, 0);
    }
    /**
     * Returns chain of `BlockHeader`s from the best proof.
     * @returns {BlockHeaders}
     */
    best_chain() {
        const ret = wasm.nipopowverifier_best_chain(this.__wbg_ptr);
        return BlockHeaders.__wrap(ret);
    }
    /**
     * Return best proof
     * @returns {NipopowProof | undefined}
     */
    best_proof() {
        const ret = wasm.nipopowverifier_best_proof(this.__wbg_ptr);
        return ret === 0 ? undefined : NipopowProof.__wrap(ret);
    }
    /**
     * Create new instance
     * @param {BlockId} genesis_block_id
     */
    constructor(genesis_block_id) {
        _assertClass(genesis_block_id, BlockId);
        var ptr0 = genesis_block_id.__destroy_into_raw();
        const ret = wasm.nipopowverifier_new(ptr0);
        this.__wbg_ptr = ret;
        NipopowVerifierFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Process given proof
     * @param {NipopowProof} new_proof
     */
    process(new_proof) {
        _assertClass(new_proof, NipopowProof);
        var ptr0 = new_proof.__destroy_into_raw();
        const ret = wasm.nipopowverifier_process(this.__wbg_ptr, ptr0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) NipopowVerifier.prototype[Symbol.dispose] = NipopowVerifier.prototype.free;
exports.NipopowVerifier = NipopowVerifier;

/**
 * newtype for box registers R4 - R9
 * @enum {4 | 5 | 6 | 7 | 8 | 9}
 */
const NonMandatoryRegisterId = Object.freeze({
    /**
     * id for R4 register
     */
    R4: 4, "4": "R4",
    /**
     * id for R5 register
     */
    R5: 5, "5": "R5",
    /**
     * id for R6 register
     */
    R6: 6, "6": "R6",
    /**
     * id for R7 register
     */
    R7: 7, "7": "R7",
    /**
     * id for R8 register
     */
    R8: 8, "8": "R8",
    /**
     * id for R9 register
     */
    R9: 9, "9": "R9",
});
exports.NonMandatoryRegisterId = NonMandatoryRegisterId;

/**
 * Blockchain parameters
 */
class Parameters {
    static __wrap(ptr) {
        const obj = Object.create(Parameters.prototype);
        obj.__wbg_ptr = ptr;
        ParametersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParametersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parameters_free(ptr, 0);
    }
    /**
     * Get current block version
     * @returns {number}
     */
    block_version() {
        const ret = wasm.parameters_block_version(this.__wbg_ptr);
        return ret;
    }
    /**
     * Validation cost per data input
     * @returns {number}
     */
    data_input_cost() {
        const ret = wasm.parameters_data_input_cost(this.__wbg_ptr);
        return ret;
    }
    /**
     * Return default blockchain parameters that were set at genesis
     * @returns {Parameters}
     */
    static default_parameters() {
        const ret = wasm.parameters_default_parameters();
        return Parameters.__wrap(ret);
    }
    /**
     * Validation cost per one transaction input
     * @returns {number}
     */
    input_cost() {
        const ret = wasm.parameters_input_cost(this.__wbg_ptr);
        return ret;
    }
    /**
     * Maximum total computation cost in a block
     * @returns {number}
     */
    max_block_cost() {
        const ret = wasm.parameters_max_block_cost(this.__wbg_ptr);
        return ret;
    }
    /**
     * Maximum size of transactions size in a block
     * @returns {number}
     */
    max_block_size() {
        const ret = wasm.parameters_max_block_size(this.__wbg_ptr);
        return ret;
    }
    /**
     * Minimum value per byte an output must have to not be considered dust
     * @returns {number}
     */
    min_value_per_byte() {
        const ret = wasm.parameters_min_value_per_byte(this.__wbg_ptr);
        return ret;
    }
    /**
     * Validation cost per one output
     * @returns {number}
     */
    output_cost() {
        const ret = wasm.parameters_output_cost(this.__wbg_ptr);
        return ret;
    }
    /**
     * Cost of storing 1 byte per Storage Period of block chain
     * @returns {number}
     */
    storage_fee_factor() {
        const ret = wasm.parameters_storage_fee_factor(this.__wbg_ptr);
        return ret;
    }
    /**
     * Cost of accessing a single token
     * @returns {number}
     */
    token_access_cost() {
        const ret = wasm.parameters_token_access_cost(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Parameters.prototype[Symbol.dispose] = Parameters.prototype.free;
exports.Parameters = Parameters;

/**
 * PoPowHeader structure. Represents the block header and unpacked interlinks
 */
class PoPowHeader {
    static __wrap(ptr) {
        const obj = Object.create(PoPowHeader.prototype);
        obj.__wbg_ptr = ptr;
        PoPowHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PoPowHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_popowheader_free(ptr, 0);
    }
    /**
     * Validates interlinks merkle root with compact merkle multiproof. See [`PoPowHeader::interlinks_proof`] for BatchMerkleProof access
     * @returns {boolean}
     */
    check_interlinks_proof() {
        const ret = wasm.popowheader_check_interlinks_proof(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns block header
     * @returns {BlockHeader}
     */
    header() {
        const ret = wasm.popowheader_header(this.__wbg_ptr);
        return BlockHeader.__wrap(ret);
    }
    /**
     * Returns block height for Header
     * @returns {number}
     */
    height() {
        const ret = wasm.popowheader_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Returns Block ID for Header
     * @returns {BlockId}
     */
    id() {
        const ret = wasm.popowheader_id(this.__wbg_ptr);
        return BlockId.__wrap(ret);
    }
    /**
     * Returns interlinks for PoPowHeader
     * @returns {any}
     */
    interlinks() {
        const ret = wasm.popowheader_interlinks(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns interlinks proof [`crate::batchmerkleproof::BatchMerkleProof`]
     * @returns {BatchMerkleProof}
     */
    interlinks_proof() {
        const ret = wasm.popowheader_interlinks_proof(this.__wbg_ptr);
        return BatchMerkleProof.__wrap(ret);
    }
}
if (Symbol.dispose) PoPowHeader.prototype[Symbol.dispose] = PoPowHeader.prototype.free;
exports.PoPowHeader = PoPowHeader;

/**
 * Block header with the current `spendingTransaction`, that can be predicted
 * by a miner before it's formation
 */
class PreHeader {
    static __wrap(ptr) {
        const obj = Object.create(PreHeader.prototype);
        obj.__wbg_ptr = ptr;
        PreHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PreHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_preheader_free(ptr, 0);
    }
    /**
     * Create using data from block header
     * @param {BlockHeader} block_header
     * @returns {PreHeader}
     */
    static from_block_header(block_header) {
        _assertClass(block_header, BlockHeader);
        var ptr0 = block_header.__destroy_into_raw();
        const ret = wasm.preheader_from_block_header(ptr0);
        return PreHeader.__wrap(ret);
    }
}
if (Symbol.dispose) PreHeader.prototype[Symbol.dispose] = PreHeader.prototype.free;
exports.PreHeader = PreHeader;

/**
 * Propositions list(public keys)
 */
class Propositions {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PropositionsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_propositions_free(ptr, 0);
    }
    /**
     * Adding new proposition
     * @param {Uint8Array} proposition
     */
    add_proposition_from_byte(proposition) {
        const ptr0 = passArray8ToWasm0(proposition, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.propositions_add_proposition_from_byte(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Create empty proposition holder
     */
    constructor() {
        const ret = wasm.propositions_new();
        this.__wbg_ptr = ret;
        PropositionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Propositions.prototype[Symbol.dispose] = Propositions.prototype.free;
exports.Propositions = Propositions;

/**
 * Proof of correctness of tx spending
 */
class ProverResult {
    static __wrap(ptr) {
        const obj = Object.create(ProverResult.prototype);
        obj.__wbg_ptr = ptr;
        ProverResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProverResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proverresult_free(ptr, 0);
    }
    /**
     * Get extension
     * @returns {ContextExtension}
     */
    extension() {
        const ret = wasm.proverresult_extension(this.__wbg_ptr);
        return ContextExtension.__wrap(ret);
    }
    /**
     * Get proof
     * @returns {Uint8Array}
     */
    proof() {
        const ret = wasm.proverresult_proof(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.proverresult_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProverResult.prototype[Symbol.dispose] = ProverResult.prototype.free;
exports.ProverResult = ProverResult;

/**
 * Represent `reduced` transaction, i.e. unsigned transaction where each unsigned input
 * is augmented with ReducedInput which contains a script reduction result.
 * After an unsigned transaction is reduced it can be signed without context.
 * Thus, it can be serialized and transferred for example to Cold Wallet and signed
 * in an environment where secrets are known.
 * see EIP-19 for more details -
 * <https://github.com/ergoplatform/eips/blob/f280890a4163f2f2e988a0091c078e36912fc531/eip-0019.md>
 */
class ReducedTransaction {
    static __wrap(ptr) {
        const obj = Object.create(ReducedTransaction.prototype);
        obj.__wbg_ptr = ptr;
        ReducedTransactionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ReducedTransactionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_reducedtransaction_free(ptr, 0);
    }
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     * @param {string} json
     * @returns {ReducedTransaction}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.reducedtransaction_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ReducedTransaction.__wrap(ret[0]);
    }
    /**
     * Returns `reduced` transaction, i.e. unsigned transaction where each unsigned input
     * is augmented with ReducedInput which contains a script reduction result.
     * @param {UnsignedTransaction} unsigned_tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @param {ErgoStateContext} state_context
     * @returns {ReducedTransaction}
     */
    static from_unsigned_tx(unsigned_tx, boxes_to_spend, data_boxes, state_context) {
        _assertClass(unsigned_tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        _assertClass(state_context, ErgoStateContext);
        const ret = wasm.reducedtransaction_from_unsigned_tx(unsigned_tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr, state_context.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ReducedTransaction.__wrap(ret[0]);
    }
    /**
     * Parses ReducedTransaction or fails with error
     * @param {Uint8Array} data
     * @returns {ReducedTransaction}
     */
    static sigma_parse_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.reducedtransaction_sigma_parse_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ReducedTransaction.__wrap(ret[0]);
    }
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.reducedtransaction_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.reducedtransaction_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns the unsigned transaction
     * @returns {UnsignedTransaction}
     */
    unsigned_tx() {
        const ret = wasm.reducedtransaction_unsigned_tx(this.__wbg_ptr);
        return UnsignedTransaction.__wrap(ret);
    }
}
if (Symbol.dispose) ReducedTransaction.prototype[Symbol.dispose] = ReducedTransaction.prototype.free;
exports.ReducedTransaction = ReducedTransaction;

/**
 * Secret key for the prover
 */
class SecretKey {
    static __wrap(ptr) {
        const obj = Object.create(SecretKey.prototype);
        obj.__wbg_ptr = ptr;
        SecretKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SecretKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_secretkey_free(ptr, 0);
    }
    /**
     * Parse Diffie-Hellman tuple secret key from bytes.
     * secret is expected as SEC-1-encoded scalar of 32 bytes,
     * g,h,u,v are expected as 33-byte compressed points
     * @param {Uint8Array} secret
     * @param {Uint8Array} g
     * @param {Uint8Array} h
     * @param {Uint8Array} u
     * @param {Uint8Array} v
     * @returns {SecretKey}
     */
    static dht_from_bytes(secret, g, h, u, v) {
        const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(g, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(h, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(u, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(v, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.secretkey_dht_from_bytes(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SecretKey.__wrap(ret[0]);
    }
    /**
     * Parse dlog secret key from bytes (SEC-1-encoded scalar)
     * @param {Uint8Array} bytes
     * @returns {SecretKey}
     */
    static dlog_from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.secretkey_dlog_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SecretKey.__wrap(ret[0]);
    }
    /**
     * Parse secret key from bytes (expected 32 bytes for Dlog, 32(secret)+33(g)+33(h)+33(u)+33(v)=164 bytes for DHT)
     * secret is expected as SEC-1-encoded scalar of 32 bytes,
     * g,h,u,v are expected as 33-byte compressed points
     * @param {Uint8Array} bytes
     * @returns {SecretKey}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.secretkey_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SecretKey.__wrap(ret[0]);
    }
    /**
     * Parse secret key from JSON string (Dlog expected as base16-encoded bytes, DHT in node REST API format)
     * @param {string} json_str
     * @returns {SecretKey}
     */
    static from_json(json_str) {
        const ptr0 = passStringToWasm0(json_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.secretkey_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SecretKey.__wrap(ret[0]);
    }
    /**
     * Address (encoded public image)
     * @returns {Address}
     */
    get_address() {
        const ret = wasm.secretkey_get_address(this.__wbg_ptr);
        return Address.__wrap(ret);
    }
    /**
     * generate random key
     * @returns {SecretKey}
     */
    static random_dlog() {
        const ret = wasm.secretkey_random_dlog();
        return SecretKey.__wrap(ret);
    }
    /**
     * Serialized secret key (32 bytes for Dlog, 32(secret)+33(g)+33(h)+33(u)+33(v)=164 bytes for DHT)
     * DHT format is the same as in from_bytes
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.secretkey_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Encode secret key to JSON string (Dlog as base16-encoded bytes, DHT in node REST API format)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.secretkey_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) SecretKey.prototype[Symbol.dispose] = SecretKey.prototype.free;
exports.SecretKey = SecretKey;

/**
 * SecretKey collection
 */
class SecretKeys {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SecretKeysFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_secretkeys_free(ptr, 0);
    }
    /**
     * Adds an elements to the collection
     * @param {SecretKey} elem
     */
    add(elem) {
        _assertClass(elem, SecretKey);
        wasm.secretkeys_add(this.__wbg_ptr, elem.__wbg_ptr);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {SecretKey}
     */
    get(index) {
        const ret = wasm.secretkeys_get(this.__wbg_ptr, index);
        return SecretKey.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.secretkeys_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty SecretKeys
     */
    constructor() {
        const ret = wasm.secretkeys_new();
        this.__wbg_ptr = ret;
        SecretKeysFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) SecretKeys.prototype[Symbol.dispose] = SecretKeys.prototype.free;
exports.SecretKeys = SecretKeys;

/**
 * Naive box selector, collects inputs until target balance is reached
 */
class SimpleBoxSelector {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimpleBoxSelectorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_simpleboxselector_free(ptr, 0);
    }
    /**
     * Create empty SimpleBoxSelector
     */
    constructor() {
        const ret = wasm.simpleboxselector_new();
        this.__wbg_ptr = ret;
        SimpleBoxSelectorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Selects inputs to satisfy target balance and tokens.
     * `inputs` - available inputs (returns an error, if empty),
     * `target_balance` - coins (in nanoERGs) needed,
     * `target_tokens` - amount of tokens needed.
     * Returns selected inputs and box assets(value+tokens) with change.
     * @param {ErgoBoxes} inputs
     * @param {BoxValue} target_balance
     * @param {Tokens} target_tokens
     * @returns {BoxSelection}
     */
    select(inputs, target_balance, target_tokens) {
        _assertClass(inputs, ErgoBoxes);
        _assertClass(target_balance, BoxValue);
        _assertClass(target_tokens, Tokens);
        const ret = wasm.simpleboxselector_select(this.__wbg_ptr, inputs.__wbg_ptr, target_balance.__wbg_ptr, target_tokens.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BoxSelection.__wrap(ret[0]);
    }
}
if (Symbol.dispose) SimpleBoxSelector.prototype[Symbol.dispose] = SimpleBoxSelector.prototype.free;
exports.SimpleBoxSelector = SimpleBoxSelector;

/**
 * Token represented with token id paired with it's amount
 */
class Token {
    static __wrap(ptr) {
        const obj = Object.create(Token.prototype);
        obj.__wbg_ptr = ptr;
        TokenFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TokenFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_token_free(ptr, 0);
    }
    /**
     * Get token amount
     * @returns {TokenAmount}
     */
    amount() {
        const ret = wasm.token_amount(this.__wbg_ptr);
        return TokenAmount.__wrap(ret);
    }
    /**
     * Get token id
     * @returns {TokenId}
     */
    id() {
        const ret = wasm.token_id(this.__wbg_ptr);
        return TokenId.__wrap(ret);
    }
    /**
     * Create a token with given token id and amount
     * @param {TokenId} token_id
     * @param {TokenAmount} amount
     */
    constructor(token_id, amount) {
        _assertClass(token_id, TokenId);
        _assertClass(amount, TokenAmount);
        const ret = wasm.token_new(token_id.__wbg_ptr, amount.__wbg_ptr);
        this.__wbg_ptr = ret;
        TokenFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with token amount encoding as string)
     * @returns {any}
     */
    to_js_eip12() {
        const ret = wasm.token_to_js_eip12(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.token_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) Token.prototype[Symbol.dispose] = Token.prototype.free;
exports.Token = Token;

/**
 * Token amount with bound checks
 */
class TokenAmount {
    static __wrap(ptr) {
        const obj = Object.create(TokenAmount.prototype);
        obj.__wbg_ptr = ptr;
        TokenAmountFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TokenAmountFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tokenamount_free(ptr, 0);
    }
    /**
     * Get value as signed 64-bit long (I64)
     * @returns {I64}
     */
    as_i64() {
        const ret = wasm.tokenamount_as_i64(this.__wbg_ptr);
        return I64.__wrap(ret);
    }
    /**
     * Create from i64 with bounds check
     * @param {I64} v
     * @returns {TokenAmount}
     */
    static from_i64(v) {
        _assertClass(v, I64);
        const ret = wasm.tokenamount_from_i64(v.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TokenAmount.__wrap(ret[0]);
    }
    /**
     * big-endian byte array representation
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.tokenamount_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TokenAmount.prototype[Symbol.dispose] = TokenAmount.prototype.free;
exports.TokenAmount = TokenAmount;

/**
 * Token id (32 byte digest)
 */
class TokenId {
    static __wrap(ptr) {
        const obj = Object.create(TokenId.prototype);
        obj.__wbg_ptr = ptr;
        TokenIdFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TokenIdFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tokenid_free(ptr, 0);
    }
    /**
     * Returns byte array (32 bytes)
     * @returns {Uint8Array}
     */
    as_bytes() {
        const ret = wasm.tokenid_as_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create token id from ergo box id (32 byte digest)
     * @param {BoxId} box_id
     * @returns {TokenId}
     */
    static from_box_id(box_id) {
        _assertClass(box_id, BoxId);
        const ret = wasm.tokenid_from_box_id(box_id.__wbg_ptr);
        return TokenId.__wrap(ret);
    }
    /**
     * Parse token id (32 byte digest) from base16-encoded string
     * @param {string} str
     * @returns {TokenId}
     */
    static from_str(str) {
        const ptr0 = passStringToWasm0(str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tokenid_from_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TokenId.__wrap(ret[0]);
    }
    /**
     * Base16 encoded string
     * @returns {string}
     */
    to_str() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.tokenid_to_str(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) TokenId.prototype[Symbol.dispose] = TokenId.prototype.free;
exports.TokenId = TokenId;

/**
 * Array of tokens
 */
class Tokens {
    static __wrap(ptr) {
        const obj = Object.create(Tokens.prototype);
        obj.__wbg_ptr = ptr;
        TokensFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TokensFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tokens_free(ptr, 0);
    }
    /**
     * Adds an elements to the collection
     * @param {Token} elem
     */
    add(elem) {
        _assertClass(elem, Token);
        wasm.tokens_add(this.__wbg_ptr, elem.__wbg_ptr);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {Token}
     */
    get(index) {
        const ret = wasm.tokens_get(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Token.__wrap(ret[0]);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.tokens_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty Tokens
     */
    constructor() {
        const ret = wasm.tokens_new();
        this.__wbg_ptr = ret;
        TokensFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Tokens.prototype[Symbol.dispose] = Tokens.prototype.free;
exports.Tokens = Tokens;

/**
 *
 * * ErgoTransaction is an atomic state transition operation. It destroys Boxes from the state
 * * and creates new ones. If transaction is spending boxes protected by some non-trivial scripts,
 * * its inputs should also contain proof of spending correctness - context extension (user-defined
 * * key-value map) and data inputs (links to existing boxes in the state) that may be used during
 * * script reduction to crypto, signatures that satisfies the remaining cryptographic protection
 * * of the script.
 * * Transactions are not encrypted, so it is possible to browse and view every transaction ever
 * * collected into a block.
 *
 */
class Transaction {
    static __wrap(ptr) {
        const obj = Object.create(Transaction.prototype);
        obj.__wbg_ptr = ptr;
        TransactionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransactionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transaction_free(ptr, 0);
    }
    /**
     * Data inputs for transaction
     * @returns {DataInputs}
     */
    data_inputs() {
        const ret = wasm.transaction_data_inputs(this.__wbg_ptr);
        return DataInputs.__wrap(ret);
    }
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     * @param {string} json
     * @returns {Transaction}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transaction_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Create Transaction from UnsignedTransaction and an array of proofs in the same order as
     * UnsignedTransaction.inputs with empty proof indicated with empty byte array
     * @param {UnsignedTransaction} unsigned_tx
     * @param {Uint8Array[]} proofs
     * @returns {Transaction}
     */
    static from_unsigned_tx(unsigned_tx, proofs) {
        _assertClass(unsigned_tx, UnsignedTransaction);
        var ptr0 = unsigned_tx.__destroy_into_raw();
        const ptr1 = passArrayJsValueToWasm0(proofs, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.transaction_from_unsigned_tx(ptr0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Get id for transaction
     * @returns {TxId}
     */
    id() {
        const ret = wasm.transaction_id(this.__wbg_ptr);
        return TxId.__wrap(ret);
    }
    /**
     * Inputs for transaction
     * @returns {Inputs}
     */
    inputs() {
        const ret = wasm.transaction_inputs(this.__wbg_ptr);
        return Inputs.__wrap(ret);
    }
    /**
     * Create new transaction
     * @param {Inputs} inputs
     * @param {DataInputs} data_inputs
     * @param {ErgoBoxCandidates} outputs
     */
    constructor(inputs, data_inputs, outputs) {
        _assertClass(inputs, Inputs);
        _assertClass(data_inputs, DataInputs);
        _assertClass(outputs, ErgoBoxCandidates);
        const ret = wasm.transaction_new(inputs.__wbg_ptr, data_inputs.__wbg_ptr, outputs.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        TransactionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Output candidates for transaction
     * @returns {ErgoBoxCandidates}
     */
    output_candidates() {
        const ret = wasm.transaction_output_candidates(this.__wbg_ptr);
        return ErgoBoxCandidates.__wrap(ret);
    }
    /**
     * Returns ErgoBox's created from ErgoBoxCandidate's with tx id and indices
     * @returns {ErgoBoxes}
     */
    outputs() {
        const ret = wasm.transaction_outputs(this.__wbg_ptr);
        return ErgoBoxes.__wrap(ret);
    }
    /**
     * Parses Transaction or fails with error
     * @param {Uint8Array} data
     * @returns {Transaction}
     */
    static sigma_parse_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transaction_sigma_parse_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     * @returns {Uint8Array}
     */
    sigma_serialize_bytes() {
        const ret = wasm.transaction_sigma_serialize_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amount encoding as strings)
     * @returns {any}
     */
    to_js_eip12() {
        const ret = wasm.transaction_to_js_eip12(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.transaction_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Check the signature of the transaction's input corresponding
     * to the given input box, guarded by P2PK script
     * @param {ErgoBox} input_box
     * @returns {boolean}
     */
    verify_p2pk_input(input_box) {
        _assertClass(input_box, ErgoBox);
        var ptr0 = input_box.__destroy_into_raw();
        const ret = wasm.transaction_verify_p2pk_input(this.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) Transaction.prototype[Symbol.dispose] = Transaction.prototype.free;
exports.Transaction = Transaction;

/**
 * TransactionHintsBag
 */
class TransactionHintsBag {
    static __wrap(ptr) {
        const obj = Object.create(TransactionHintsBag.prototype);
        obj.__wbg_ptr = ptr;
        TransactionHintsBagFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransactionHintsBagFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionhintsbag_free(ptr, 0);
    }
    /**
     * Adding hints for input
     * @param {number} index
     * @param {HintsBag} hints_bag
     */
    add_hints_for_input(index, hints_bag) {
        _assertClass(hints_bag, HintsBag);
        wasm.transactionhintsbag_add_hints_for_input(this.__wbg_ptr, index, hints_bag.__wbg_ptr);
    }
    /**
     * Outputting HintsBag corresponding for an input index
     * @param {number} index
     * @returns {HintsBag}
     */
    all_hints_for_input(index) {
        const ret = wasm.transactionhintsbag_all_hints_for_input(this.__wbg_ptr, index);
        return HintsBag.__wrap(ret);
    }
    /**
     * Empty TransactionHintsBag
     * @returns {TransactionHintsBag}
     */
    static empty() {
        const ret = wasm.transactionhintsbag_empty();
        return TransactionHintsBag.__wrap(ret);
    }
    /**
     * Parse from JSON object (node format)
     * @param {string} json
     * @returns {TransactionHintsBag}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transactionhintsbag_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TransactionHintsBag.__wrap(ret[0]);
    }
    /**
     * Return JSON object (node format)
     * @returns {any}
     */
    to_json() {
        const ret = wasm.transactionhintsbag_to_json(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) TransactionHintsBag.prototype[Symbol.dispose] = TransactionHintsBag.prototype.free;
exports.TransactionHintsBag = TransactionHintsBag;

/**
 * Unsigned transaction builder
 */
class TxBuilder {
    static __wrap(ptr) {
        const obj = Object.create(TxBuilder.prototype);
        obj.__wbg_ptr = ptr;
        TxBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TxBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_txbuilder_free(ptr, 0);
    }
    /**
     * Suggested transaction fee (semi-default value used across wallets and dApps as of Oct 2020)
     * @returns {BoxValue}
     */
    static SUGGESTED_TX_FEE() {
        const ret = wasm.txbuilder_SUGGESTED_TX_FEE();
        return BoxValue.__wrap(ret);
    }
    /**
     * Get box selection
     * @returns {BoxSelection}
     */
    box_selection() {
        const ret = wasm.txbuilder_box_selection(this.__wbg_ptr);
        return BoxSelection.__wrap(ret);
    }
    /**
     * Build the unsigned transaction
     * @returns {UnsignedTransaction}
     */
    build() {
        const ret = wasm.txbuilder_build(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedTransaction.__wrap(ret[0]);
    }
    /**
     * Get change address
     * @returns {Address}
     */
    change_address() {
        const ret = wasm.txbuilder_change_address(this.__wbg_ptr);
        return Address.__wrap(ret);
    }
    /**
     * Get current height
     * @returns {number}
     */
    current_height() {
        const ret = wasm.txbuilder_current_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get data inputs
     * @returns {DataInputs}
     */
    data_inputs() {
        const ret = wasm.txbuilder_data_inputs(this.__wbg_ptr);
        return DataInputs.__wrap(ret);
    }
    /**
     * Get fee amount
     * @returns {BoxValue}
     */
    fee_amount() {
        const ret = wasm.txbuilder_fee_amount(this.__wbg_ptr);
        return BoxValue.__wrap(ret);
    }
    /**
     * Creates new TxBuilder
     * `box_selection` - selected input boxes (via [`super::box_selector`])
     * `output_candidates` - output boxes to be "created" in this transaction,
     * `current_height` - chain height that will be used in additionally created boxes (change, miner's fee, etc.),
     * `fee_amount` - miner's fee,
     * `change_address` - change (inputs - outputs) will be sent to this address,
     * will be given to miners,
     * @param {BoxSelection} box_selection
     * @param {ErgoBoxCandidates} output_candidates
     * @param {number} current_height
     * @param {BoxValue} fee_amount
     * @param {Address} change_address
     * @returns {TxBuilder}
     */
    static new(box_selection, output_candidates, current_height, fee_amount, change_address) {
        _assertClass(box_selection, BoxSelection);
        _assertClass(output_candidates, ErgoBoxCandidates);
        _assertClass(fee_amount, BoxValue);
        _assertClass(change_address, Address);
        const ret = wasm.txbuilder_new(box_selection.__wbg_ptr, output_candidates.__wbg_ptr, current_height, fee_amount.__wbg_ptr, change_address.__wbg_ptr);
        return TxBuilder.__wrap(ret);
    }
    /**
     * Get outputs EXCLUDING fee and change
     * @returns {ErgoBoxCandidates}
     */
    output_candidates() {
        const ret = wasm.txbuilder_output_candidates(this.__wbg_ptr);
        return ErgoBoxCandidates.__wrap(ret);
    }
    /**
     * Set context extension for a given input
     * @param {BoxId} box_id
     * @param {ContextExtension} context_extension
     */
    set_context_extension(box_id, context_extension) {
        _assertClass(box_id, BoxId);
        _assertClass(context_extension, ContextExtension);
        wasm.txbuilder_set_context_extension(this.__wbg_ptr, box_id.__wbg_ptr, context_extension.__wbg_ptr);
    }
    /**
     * Set transaction's data inputs
     * @param {DataInputs} data_inputs
     */
    set_data_inputs(data_inputs) {
        _assertClass(data_inputs, DataInputs);
        wasm.txbuilder_set_data_inputs(this.__wbg_ptr, data_inputs.__wbg_ptr);
    }
    /**
     * Permits the burn of the given token amount, i.e. allows this token amount to be omitted in the outputs
     * @param {Tokens} tokens
     */
    set_token_burn_permit(tokens) {
        _assertClass(tokens, Tokens);
        wasm.txbuilder_set_token_burn_permit(this.__wbg_ptr, tokens.__wbg_ptr);
    }
}
if (Symbol.dispose) TxBuilder.prototype[Symbol.dispose] = TxBuilder.prototype.free;
exports.TxBuilder = TxBuilder;

/**
 * Transaction id
 */
class TxId {
    static __wrap(ptr) {
        const obj = Object.create(TxId.prototype);
        obj.__wbg_ptr = ptr;
        TxIdFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TxIdFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_txid_free(ptr, 0);
    }
    /**
     * convert a hex string into a TxId
     * @param {string} s
     * @returns {TxId}
     */
    static from_str(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.txid_from_str(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TxId.__wrap(ret[0]);
    }
    /**
     * get the tx id as bytes
     * @returns {string}
     */
    to_str() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.txid_to_str(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Zero (empty) transaction id (to use as dummy value in tests)
     * @returns {TxId}
     */
    static zero() {
        const ret = wasm.txid_zero();
        return TxId.__wrap(ret);
    }
}
if (Symbol.dispose) TxId.prototype[Symbol.dispose] = TxId.prototype.free;
exports.TxId = TxId;

/**
 * Unsigned 256-bit integer type
 */
class UnsignedBigInt {
    static __wrap(ptr) {
        const obj = Object.create(UnsignedBigInt.prototype);
        obj.__wbg_ptr = ptr;
        UnsignedBigIntFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnsignedBigIntFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unsignedbigint_free(ptr, 0);
    }
    /**
     * Add two UnsignedBigInts. If the result overflows an exception will be raised
     * @param {UnsignedBigInt} other
     * @returns {UnsignedBigInt}
     */
    add(other) {
        _assertClass(other, UnsignedBigInt);
        const ret = wasm.unsignedbigint_add(this.__wbg_ptr, other.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Divide self by other. Returns an exception if other == 0
     * @param {UnsignedBigInt} other
     * @returns {UnsignedBigInt}
     */
    div(other) {
        _assertClass(other, UnsignedBigInt);
        const ret = wasm.unsignedbigint_div(this.__wbg_ptr, other.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Compare two UnsignedBigInts
     * @param {UnsignedBigInt} other
     * @returns {boolean}
     */
    eq(other) {
        _assertClass(other, UnsignedBigInt);
        const ret = wasm.unsignedbigint_eq(this.__wbg_ptr, other.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create UnsignedBigInt from str with given base
     * @param {string} s
     * @param {number} radix
     * @returns {UnsignedBigInt}
     */
    static from_str_radix(s, radix) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.unsignedbigint_from_str_radix(ptr0, len0, radix);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Compute (self + other) mod modulus. Returns an exception if modulus == 0
     * @param {UnsignedBigInt} other
     * @param {UnsignedBigInt} modulus
     * @returns {UnsignedBigInt}
     */
    mod_add(other, modulus) {
        _assertClass(other, UnsignedBigInt);
        _assertClass(modulus, UnsignedBigInt);
        const ret = wasm.unsignedbigint_mod_add(this.__wbg_ptr, other.__wbg_ptr, modulus.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Compute modular inverse of self. Returns an exception if modulus == 0 or modular inverse does not exist
     * @param {UnsignedBigInt} modulus
     * @returns {UnsignedBigInt}
     */
    mod_inv(modulus) {
        _assertClass(modulus, UnsignedBigInt);
        const ret = wasm.unsignedbigint_mod_inv(this.__wbg_ptr, modulus.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Compute (self * other) mod modulus. Returns an exception if modulus == 0
     * @param {UnsignedBigInt} other
     * @param {UnsignedBigInt} modulus
     * @returns {UnsignedBigInt}
     */
    mod_mul(other, modulus) {
        _assertClass(other, UnsignedBigInt);
        _assertClass(modulus, UnsignedBigInt);
        const ret = wasm.unsignedbigint_mod_mul(this.__wbg_ptr, other.__wbg_ptr, modulus.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Compute (self - other) mod modulus. Returns an exception if modulus == 0
     * @param {UnsignedBigInt} other
     * @param {UnsignedBigInt} modulus
     * @returns {UnsignedBigInt}
     */
    mod_sub(other, modulus) {
        _assertClass(other, UnsignedBigInt);
        _assertClass(modulus, UnsignedBigInt);
        const ret = wasm.unsignedbigint_mod_sub(this.__wbg_ptr, other.__wbg_ptr, modulus.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Multiply self by other. If the result overflows an exception will be raised
     * @param {UnsignedBigInt} other
     * @returns {UnsignedBigInt}
     */
    mul(other) {
        _assertClass(other, UnsignedBigInt);
        const ret = wasm.unsignedbigint_mul(this.__wbg_ptr, other.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Create a new UnsignedBigInt from Number or JS BigInt
     * @param {any} number
     */
    constructor(number) {
        const ret = wasm.unsignedbigint_new(number);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        UnsignedBigIntFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Compute (self mod modulus)
     * @param {UnsignedBigInt} modulus
     * @returns {UnsignedBigInt}
     */
    rem(modulus) {
        _assertClass(modulus, UnsignedBigInt);
        const ret = wasm.unsignedbigint_rem(this.__wbg_ptr, modulus.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
    /**
     * Subtract other from self. If the result overflows an exception will be raised
     * @param {UnsignedBigInt} other
     * @returns {UnsignedBigInt}
     */
    sub(other) {
        _assertClass(other, UnsignedBigInt);
        const ret = wasm.unsignedbigint_sub(this.__wbg_ptr, other.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedBigInt.__wrap(ret[0]);
    }
}
if (Symbol.dispose) UnsignedBigInt.prototype[Symbol.dispose] = UnsignedBigInt.prototype.free;
exports.UnsignedBigInt = UnsignedBigInt;

/**
 * Unsigned inputs used in constructing unsigned transactions
 */
class UnsignedInput {
    static __wrap(ptr) {
        const obj = Object.create(UnsignedInput.prototype);
        obj.__wbg_ptr = ptr;
        UnsignedInputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnsignedInputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unsignedinput_free(ptr, 0);
    }
    /**
     * Get box id
     * @returns {BoxId}
     */
    box_id() {
        const ret = wasm.unsignedinput_box_id(this.__wbg_ptr);
        return BoxId.__wrap(ret);
    }
    /**
     * Get extension
     * @returns {ContextExtension}
     */
    extension() {
        const ret = wasm.unsignedinput_extension(this.__wbg_ptr);
        return ContextExtension.__wrap(ret);
    }
    /**
     * Create a new unsigned input from the provided box id
     * using an empty context extension
     * @param {BoxId} box_id
     * @returns {UnsignedInput}
     */
    static from_box_id(box_id) {
        _assertClass(box_id, BoxId);
        const ret = wasm.unsignedinput_from_box_id(box_id.__wbg_ptr);
        return UnsignedInput.__wrap(ret);
    }
    /**
     * Create new unsigned input instance from box id and extension
     * @param {BoxId} box_id
     * @param {ContextExtension} ext
     */
    constructor(box_id, ext) {
        _assertClass(box_id, BoxId);
        _assertClass(ext, ContextExtension);
        const ret = wasm.unsignedinput_new(box_id.__wbg_ptr, ext.__wbg_ptr);
        this.__wbg_ptr = ret;
        UnsignedInputFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) UnsignedInput.prototype[Symbol.dispose] = UnsignedInput.prototype.free;
exports.UnsignedInput = UnsignedInput;

/**
 * Collection of unsigned signed inputs
 */
class UnsignedInputs {
    static __wrap(ptr) {
        const obj = Object.create(UnsignedInputs.prototype);
        obj.__wbg_ptr = ptr;
        UnsignedInputsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnsignedInputsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unsignedinputs_free(ptr, 0);
    }
    /**
     * Add an element to the collection
     * @param {UnsignedInput} b
     */
    add(b) {
        _assertClass(b, UnsignedInput);
        wasm.unsignedinputs_add(this.__wbg_ptr, b.__wbg_ptr);
    }
    /**
     * Returns the element of the collection with a given index
     * @param {number} index
     * @returns {UnsignedInput}
     */
    get(index) {
        const ret = wasm.unsignedinputs_get(this.__wbg_ptr, index);
        return UnsignedInput.__wrap(ret);
    }
    /**
     * Returns the number of elements in the collection
     * @returns {number}
     */
    len() {
        const ret = wasm.unsignedinputs_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create empty UnsignedInputs
     */
    constructor() {
        const ret = wasm.unsignedinputs_new();
        this.__wbg_ptr = ret;
        UnsignedInputsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) UnsignedInputs.prototype[Symbol.dispose] = UnsignedInputs.prototype.free;
exports.UnsignedInputs = UnsignedInputs;

/**
 * Unsigned (inputs without proofs) transaction
 */
class UnsignedTransaction {
    static __wrap(ptr) {
        const obj = Object.create(UnsignedTransaction.prototype);
        obj.__wbg_ptr = ptr;
        UnsignedTransactionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnsignedTransactionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unsignedtransaction_free(ptr, 0);
    }
    /**
     * Data inputs for transaction
     * @returns {DataInputs}
     */
    data_inputs() {
        const ret = wasm.unsignedtransaction_data_inputs(this.__wbg_ptr);
        return DataInputs.__wrap(ret);
    }
    /**
     * Returns distinct token id from output_candidates as array of byte arrays
     * @returns {Uint8Array[]}
     */
    distinct_token_ids() {
        const ret = wasm.unsignedtransaction_distinct_token_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     * @param {string} json
     * @returns {UnsignedTransaction}
     */
    static from_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.unsignedtransaction_from_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedTransaction.__wrap(ret[0]);
    }
    /**
     * Get id for transaction
     * @returns {TxId}
     */
    id() {
        const ret = wasm.unsignedtransaction_id(this.__wbg_ptr);
        return TxId.__wrap(ret);
    }
    /**
     * Inputs for transaction
     * @returns {UnsignedInputs}
     */
    inputs() {
        const ret = wasm.unsignedtransaction_inputs(this.__wbg_ptr);
        return UnsignedInputs.__wrap(ret);
    }
    /**
     * Create a new unsigned transaction
     * @param {UnsignedInputs} inputs
     * @param {DataInputs} data_inputs
     * @param {ErgoBoxCandidates} output_candidates
     */
    constructor(inputs, data_inputs, output_candidates) {
        _assertClass(inputs, UnsignedInputs);
        _assertClass(data_inputs, DataInputs);
        _assertClass(output_candidates, ErgoBoxCandidates);
        const ret = wasm.unsignedtransaction_new(inputs.__wbg_ptr, data_inputs.__wbg_ptr, output_candidates.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        UnsignedTransactionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Output candidates for transaction
     * @returns {ErgoBoxCandidates}
     */
    output_candidates() {
        const ret = wasm.unsignedtransaction_output_candidates(this.__wbg_ptr);
        return ErgoBoxCandidates.__wrap(ret);
    }
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amount encoding as strings)
     * @returns {any}
     */
    to_js_eip12() {
        const ret = wasm.unsignedtransaction_to_js_eip12(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     * @returns {string}
     */
    to_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.unsignedtransaction_to_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Consumes the calling UnsignedTransaction and returns a new UnsignedTransaction containing
     * the ContextExtension in the provided input box id or returns an error if the input box cannot be found.
     * After the call the calling UnsignedTransaction will be null.
     * @param {BoxId} input_id
     * @param {ContextExtension} ext
     * @returns {UnsignedTransaction}
     */
    with_input_context_ext(input_id, ext) {
        const ptr = this.__destroy_into_raw();
        _assertClass(input_id, BoxId);
        _assertClass(ext, ContextExtension);
        const ret = wasm.unsignedtransaction_with_input_context_ext(ptr, input_id.__wbg_ptr, ext.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UnsignedTransaction.__wrap(ret[0]);
    }
}
if (Symbol.dispose) UnsignedTransaction.prototype[Symbol.dispose] = UnsignedTransaction.prototype.free;
exports.UnsignedTransaction = UnsignedTransaction;

/**
 * A collection of secret keys. This simplified signing by matching the secret keys to the correct inputs automatically.
 */
class Wallet {
    static __wrap(ptr) {
        const obj = Object.create(Wallet.prototype);
        obj.__wbg_ptr = ptr;
        WalletFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WalletFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wallet_free(ptr, 0);
    }
    /**
     * Add a secret to the wallets prover
     * @param {SecretKey} secret
     */
    add_secret(secret) {
        _assertClass(secret, SecretKey);
        wasm.wallet_add_secret(this.__wbg_ptr, secret.__wbg_ptr);
    }
    /**
     * Create wallet instance loading secret key from mnemonic
     * Returns None if a DlogSecretKey cannot be parsed from the provided phrase
     * @param {string} mnemonic_phrase
     * @param {string} mnemonic_pass
     * @returns {Wallet}
     */
    static from_mnemonic(mnemonic_phrase, mnemonic_pass) {
        const ptr0 = passStringToWasm0(mnemonic_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mnemonic_pass, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wallet_from_mnemonic(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Wallet.__wrap(ret[0]);
    }
    /**
     * Create wallet using provided secret key
     * @param {SecretKeys} secret
     * @returns {Wallet}
     */
    static from_secrets(secret) {
        _assertClass(secret, SecretKeys);
        const ret = wasm.wallet_from_secrets(secret.__wbg_ptr);
        return Wallet.__wrap(ret);
    }
    /**
     * Generate Commitments for unsigned tx
     * @param {ErgoStateContext} _state_context
     * @param {UnsignedTransaction} tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @returns {TransactionHintsBag}
     */
    generate_commitments(_state_context, tx, boxes_to_spend, data_boxes) {
        _assertClass(_state_context, ErgoStateContext);
        _assertClass(tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        const ret = wasm.wallet_generate_commitments(this.__wbg_ptr, _state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TransactionHintsBag.__wrap(ret[0]);
    }
    /**
     * Generate Commitments for reduced Transaction
     * @param {ReducedTransaction} reduced_tx
     * @returns {TransactionHintsBag}
     */
    generate_commitments_for_reduced_transaction(reduced_tx) {
        _assertClass(reduced_tx, ReducedTransaction);
        const ret = wasm.wallet_generate_commitments_for_reduced_transaction(this.__wbg_ptr, reduced_tx.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TransactionHintsBag.__wrap(ret[0]);
    }
    /**
     * Sign an arbitrary message using a P2PK address
     * @param {Address} address
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    sign_message_using_p2pk(address, message) {
        _assertClass(address, Address);
        const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wallet_sign_message_using_p2pk(this.__wbg_ptr, address.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Sign a transaction:
     * `reduced_tx` - reduced transaction, i.e. unsigned transaction where for each unsigned input
     * added a script reduction result.
     * @param {ReducedTransaction} reduced_tx
     * @returns {Transaction}
     */
    sign_reduced_transaction(reduced_tx) {
        _assertClass(reduced_tx, ReducedTransaction);
        const ret = wasm.wallet_sign_reduced_transaction(this.__wbg_ptr, reduced_tx.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Sign a multi signature reduced transaction:
     * `reduced_tx` - reduced transaction, i.e. unsigned transaction where for each unsigned input
     * added a script reduction result.
     * `tx_hints` - transaction hints bag corresponding to [`TransactionHintsBag`]
     * @param {ReducedTransaction} reduced_tx
     * @param {TransactionHintsBag} tx_hints
     * @returns {Transaction}
     */
    sign_reduced_transaction_multi(reduced_tx, tx_hints) {
        _assertClass(reduced_tx, ReducedTransaction);
        _assertClass(tx_hints, TransactionHintsBag);
        const ret = wasm.wallet_sign_reduced_transaction_multi(this.__wbg_ptr, reduced_tx.__wbg_ptr, tx_hints.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Sign a transaction:
     * `tx` - transaction to sign
     * `boxes_to_spend` - boxes corresponding to [`UnsignedTransaction::inputs`]
     * `data_boxes` - boxes corresponding to [`UnsignedTransaction::data_inputs`]
     * @param {ErgoStateContext} _state_context
     * @param {UnsignedTransaction} tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @returns {Transaction}
     */
    sign_transaction(_state_context, tx, boxes_to_spend, data_boxes) {
        _assertClass(_state_context, ErgoStateContext);
        _assertClass(tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        const ret = wasm.wallet_sign_transaction(this.__wbg_ptr, _state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Sign a multi signature transaction:
     * `tx` - transaction to sign
     * `boxes_to_spend` - boxes corresponding to [`UnsignedTransaction::inputs`]
     * `data_boxes` - boxes corresponding to [`UnsignedTransaction::data_inputs`]
     * `tx_hints` - transaction hints bag corresponding to [`TransactionHintsBag`]
     * @param {ErgoStateContext} _state_context
     * @param {UnsignedTransaction} tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @param {TransactionHintsBag} tx_hints
     * @returns {Transaction}
     */
    sign_transaction_multi(_state_context, tx, boxes_to_spend, data_boxes, tx_hints) {
        _assertClass(_state_context, ErgoStateContext);
        _assertClass(tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        _assertClass(tx_hints, TransactionHintsBag);
        const ret = wasm.wallet_sign_transaction_multi(this.__wbg_ptr, _state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr, tx_hints.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Transaction.__wrap(ret[0]);
    }
    /**
     * Sign a given tx input
     * @param {number} input_idx
     * @param {ErgoStateContext} state_context
     * @param {UnsignedTransaction} tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @returns {Input}
     */
    sign_tx_input(input_idx, state_context, tx, boxes_to_spend, data_boxes) {
        _assertClass(state_context, ErgoStateContext);
        _assertClass(tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        const ret = wasm.wallet_sign_tx_input(this.__wbg_ptr, input_idx, state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Input.__wrap(ret[0]);
    }
    /**
     * Sign a given multi-signature tx input
     * @param {number} input_idx
     * @param {ErgoStateContext} state_context
     * @param {UnsignedTransaction} tx
     * @param {ErgoBoxes} boxes_to_spend
     * @param {ErgoBoxes} data_boxes
     * @param {TransactionHintsBag} tx_hints
     * @returns {Input}
     */
    sign_tx_input_multi(input_idx, state_context, tx, boxes_to_spend, data_boxes, tx_hints) {
        _assertClass(state_context, ErgoStateContext);
        _assertClass(tx, UnsignedTransaction);
        _assertClass(boxes_to_spend, ErgoBoxes);
        _assertClass(data_boxes, ErgoBoxes);
        _assertClass(tx_hints, TransactionHintsBag);
        const ret = wasm.wallet_sign_tx_input_multi(this.__wbg_ptr, input_idx, state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr, tx_hints.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Input.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Wallet.prototype[Symbol.dispose] = Wallet.prototype.free;
exports.Wallet = Wallet;

/**
 * Encode a JS array as an Ergo tuple.
 * @param {any[]} items
 * @returns {any}
 */
function array_as_tuple(items) {
    const ptr0 = passArrayJsValueToWasm0(items, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.array_as_tuple(ptr0, len0);
    return ret;
}
exports.array_as_tuple = array_as_tuple;

/**
 * Decodes a base16 string into an array of bytes
 * @param {string} data
 * @returns {Uint8Array}
 */
function base16_decode(data) {
    const ptr0 = passStringToWasm0(data, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.base16_decode(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.base16_decode = base16_decode;

/**
 * Extracting hints form singed(invalid) Transaction
 * @param {Transaction} signed_transaction
 * @param {ErgoStateContext} state_context
 * @param {ErgoBoxes} boxes_to_spend
 * @param {ErgoBoxes} data_boxes
 * @param {Propositions} real_propositions
 * @param {Propositions} simulated_propositions
 * @returns {TransactionHintsBag}
 */
function extract_hints(signed_transaction, state_context, boxes_to_spend, data_boxes, real_propositions, simulated_propositions) {
    _assertClass(signed_transaction, Transaction);
    var ptr0 = signed_transaction.__destroy_into_raw();
    _assertClass(state_context, ErgoStateContext);
    _assertClass(boxes_to_spend, ErgoBoxes);
    _assertClass(data_boxes, ErgoBoxes);
    _assertClass(real_propositions, Propositions);
    var ptr1 = real_propositions.__destroy_into_raw();
    _assertClass(simulated_propositions, Propositions);
    var ptr2 = simulated_propositions.__destroy_into_raw();
    const ret = wasm.extract_hints(ptr0, state_context.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr, ptr1, ptr2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return TransactionHintsBag.__wrap(ret[0]);
}
exports.extract_hints = extract_hints;

/**
 * Verify transaction
 * @param {Transaction} tx
 * @param {ErgoStateContext} state_context
 * @param {ErgoBoxes} boxes_to_spend
 * @param {ErgoBoxes} data_boxes
 */
function validate_tx(tx, state_context, boxes_to_spend, data_boxes) {
    _assertClass(tx, Transaction);
    _assertClass(state_context, ErgoStateContext);
    _assertClass(boxes_to_spend, ErgoBoxes);
    _assertClass(data_boxes, ErgoBoxes);
    const ret = wasm.validate_tx(tx.__wbg_ptr, state_context.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.validate_tx = validate_tx;

/**
 * Verify that the signature is presented to satisfy SigmaProp conditions.
 * @param {Address} address
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
function verify_signature(address, message, signature) {
    _assertClass(address, Address);
    const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.verify_signature(address.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.verify_signature = verify_signature;

/**
 * Verify transaction input's proof
 * @param {number} input_idx
 * @param {ErgoStateContext} state_context
 * @param {Transaction} tx
 * @param {ErgoBoxes} boxes_to_spend
 * @param {ErgoBoxes} data_boxes
 * @returns {boolean}
 */
function verify_tx_input_proof(input_idx, state_context, tx, boxes_to_spend, data_boxes) {
    _assertClass(state_context, ErgoStateContext);
    _assertClass(tx, Transaction);
    _assertClass(boxes_to_spend, ErgoBoxes);
    _assertClass(data_boxes, ErgoBoxes);
    const ret = wasm.verify_tx_input_proof(input_idx, state_context.__wbg_ptr, tx.__wbg_ptr, boxes_to_spend.__wbg_ptr, data_boxes.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.verify_tx_input_proof = verify_tx_input_proof;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_BigInt_0ede205155d851f2: function() { return handleError(function (arg0) {
            const ret = BigInt(arg0);
            return ret;
        }, arguments); },
        __wbg_BigInt_2cf31682ed9a9f4e: function(arg0) {
            const ret = BigInt(arg0);
            return ret;
        },
        __wbg_Error_67e7344beaa85059: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_bigint_60fc0336cb14f5d7: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_fcda5e3902d732fe: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_edb6b15aa3afe12e: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_c4f7cb494a2a21f1: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_lt_e430b211ca981006: function(arg0, arg1) {
            const ret = arg0 < arg1;
            return ret;
        },
        __wbg___wbindgen_neg_52a16114ee840d1e: function(arg0) {
            const ret = -arg0;
            return ret;
        },
        __wbg___wbindgen_number_get_1dc732b810cb937c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_6bcf8d3e20937e46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_b1f0ab13c737f856: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Uint8Array_598adc0fef426aa8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_5674713bb7b79043: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_31bdaf014f5fbde2: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_4e1adc0d42e23620: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_a32a1ab6c6655abe: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_4ee02165f9de919e: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_5ffeddb9d9fbb96f: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_parse_6937a9050adfb0e1: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_ae9f5e7459250748: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_bfdf956ba476f65b: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_name_6e2a5da46a9ae1e7: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_stringify_54b3d9b61602aee6: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_subarray_1daff70dde20c145: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_toString_093fb401d0dd2449: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.toString(arg1);
            return ret;
        }, arguments); },
        __wbg_toString_96ec7ef6b2883d19: function(arg0, arg1, arg2) {
            const ret = arg1.toString(arg2);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_valueOf_4c9bb6f5ee563bdc: function(arg0) {
            const ret = arg0.valueOf();
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ergo_lib_wasm_bg.js": import0,
    };
}

const AddressFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_address_free(ptr, 1));
const BatchMerkleProofFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_batchmerkleproof_free(ptr, 1));
const BlockHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blockheader_free(ptr, 1));
const BlockHeadersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blockheaders_free(ptr, 1));
const BlockIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blockid_free(ptr, 1));
const BoxIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boxid_free(ptr, 1));
const BoxSelectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boxselection_free(ptr, 1));
const BoxValueFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boxvalue_free(ptr, 1));
const CommitmentHintFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_commitmenthint_free(ptr, 1));
const ConstantFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_constant_free(ptr, 1));
const ContextExtensionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_contextextension_free(ptr, 1));
const ContractFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_contract_free(ptr, 1));
const DataInputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_datainput_free(ptr, 1));
const DataInputsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_datainputs_free(ptr, 1));
const DerivationPathFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_derivationpath_free(ptr, 1));
const ErgoBoxFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergobox_free(ptr, 1));
const ErgoBoxAssetsDataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxassetsdata_free(ptr, 1));
const ErgoBoxAssetsDataListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxassetsdatalist_free(ptr, 1));
const ErgoBoxCandidateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxcandidate_free(ptr, 1));
const ErgoBoxCandidateBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxcandidatebuilder_free(ptr, 1));
const ErgoBoxCandidatesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxcandidates_free(ptr, 1));
const ErgoBoxesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergoboxes_free(ptr, 1));
const ErgoStateContextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergostatecontext_free(ptr, 1));
const ErgoTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ergotree_free(ptr, 1));
const ExtPubKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_extpubkey_free(ptr, 1));
const ExtSecretKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_extsecretkey_free(ptr, 1));
const HintsBagFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hintsbag_free(ptr, 1));
const I64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_i64_free(ptr, 1));
const InputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_input_free(ptr, 1));
const InputsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inputs_free(ptr, 1));
const LevelNodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_levelnode_free(ptr, 1));
const MerkleProofFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_merkleproof_free(ptr, 1));
const MinerAddressFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mineraddress_free(ptr, 1));
const MnemonicFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mnemonic_free(ptr, 1));
const NetworkAddressFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_networkaddress_free(ptr, 1));
const NipopowProofFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_nipopowproof_free(ptr, 1));
const NipopowVerifierFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_nipopowverifier_free(ptr, 1));
const ParametersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parameters_free(ptr, 1));
const PoPowHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_popowheader_free(ptr, 1));
const PreHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_preheader_free(ptr, 1));
const PropositionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_propositions_free(ptr, 1));
const ProverResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proverresult_free(ptr, 1));
const ReducedTransactionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_reducedtransaction_free(ptr, 1));
const SecretKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_secretkey_free(ptr, 1));
const SecretKeysFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_secretkeys_free(ptr, 1));
const SimpleBoxSelectorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_simpleboxselector_free(ptr, 1));
const TokenFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_token_free(ptr, 1));
const TokenAmountFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tokenamount_free(ptr, 1));
const TokenIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tokenid_free(ptr, 1));
const TokensFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tokens_free(ptr, 1));
const TransactionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transaction_free(ptr, 1));
const TransactionHintsBagFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transactionhintsbag_free(ptr, 1));
const TxBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_txbuilder_free(ptr, 1));
const TxIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_txid_free(ptr, 1));
const UnsignedBigIntFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unsignedbigint_free(ptr, 1));
const UnsignedInputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unsignedinput_free(ptr, 1));
const UnsignedInputsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unsignedinputs_free(ptr, 1));
const UnsignedTransactionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unsignedtransaction_free(ptr, 1));
const WalletFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wallet_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/ergo_lib_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
