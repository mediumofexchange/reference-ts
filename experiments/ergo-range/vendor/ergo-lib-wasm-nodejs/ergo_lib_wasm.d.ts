/* tslint:disable */
/* eslint-disable */

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
export class Address {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the type of the address
     */
    address_type_prefix(): AddressTypePrefix;
    /**
     * Returns underlying value for each address type
     * (serialized EcPoint for P2PK, stored bytes for P2SH and P2S)
     */
    content_bytes(): Uint8Array;
    /**
     * Decode (base58) address from string without checking the network prefix
     */
    static from_base58(s: string): Address;
    /**
     * Decode from a serialized address (that includes the network prefix)
     */
    static from_bytes(data: Uint8Array): Address;
    /**
     * Decode (base58) mainnet address from string, checking that address is from the mainnet
     */
    static from_mainnet_str(s: string): Address;
    /**
     * Create an address from a public key
     */
    static from_public_key(bytes: Uint8Array): Address;
    /**
     * Decode (base58) testnet address from string, checking that address is from the testnet
     */
    static from_testnet_str(s: string): Address;
    /**
     * Create a P2PK address from serialized PK bytes(EcPoint/GroupElement)
     */
    static p2pk_from_pk_bytes(bytes: Uint8Array): Address;
    /**
     * Re-create the address from ErgoTree that was built from the address
     *
     * At some point in the past a user entered an address from which the ErgoTree was built.
     * Re-create the address from this ErgoTree.
     * `tree` - ErgoTree that was created from an Address
     */
    static recreate_from_ergo_tree(ergo_tree: ErgoTree): Address;
    /**
     * Encode (base58) address
     */
    to_base58(network_prefix: NetworkPrefix): string;
    /**
     * Encode address as serialized bytes (that includes the network prefix)
     */
    to_bytes(network_prefix: NetworkPrefix): Uint8Array;
    /**
     * Creates an ErgoTree script from the address
     */
    to_ergo_tree(): ErgoTree;
}

/**
 * Address types
 */
export enum AddressTypePrefix {
    /**
     * 0x01 - Pay-to-PublicKey(P2PK) address
     */
    P2Pk = 1,
    /**
     * 0x02 - Pay-to-Script-Hash(P2SH)
     */
    Pay2Sh = 2,
    /**
     * 0x03 - Pay-to-Script(P2S)
     */
    Pay2S = 3,
}

/**
 * BatchMerkleProof type to validate root hash for multiple nodes
 */
export class BatchMerkleProof {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates a new [`BatchMerkleProof`] from json representation
     */
    static from_json(json: any): BatchMerkleProof;
    /**
     * Converts [`BatchMerkleProof`] to json representation
     */
    to_json(): any;
    /**
     * Calculates root hash for [`BatchMerkleProof`] and compares it against expected root hash
     */
    valid(expected_root: Uint8Array): boolean;
}

/**
 * Block header
 */
export class BlockHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse from JSON (Node API)
     */
    static from_json(json: string): BlockHeader;
    /**
     * Get Header's id
     */
    id(): BlockId;
    /**
     * Get transactions root
     */
    transactions_root(): Uint8Array;
}

/**
 * Collection of BlockHeaders
 */
export class BlockHeaders {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add an element to the collection
     */
    add(b: BlockHeader): void;
    /**
     * parse BlockHeader array from JSON (Node API)
     */
    static from_json(json_vals: any[]): BlockHeaders;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): BlockHeader;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create new collection with one element
     */
    constructor(b: BlockHeader);
}

/**
 * Block id
 */
export class BlockId {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Equality check
     */
    equals(id: BlockId): boolean;
    /**
     * Parse from base 16 encoded string
     */
    static from_str(id: string): BlockId;
}

/**
 * Box id (32-byte digest)
 */
export class BoxId {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns byte array (32 bytes)
     */
    as_bytes(): Uint8Array;
    /**
     * Parse box id (32 byte digest) from base16-encoded string
     */
    static from_str(box_id_str: string): BoxId;
    /**
     * Base16 encoded string
     */
    to_str(): string;
}

/**
 * Selected boxes with change boxes (by [`BoxSelector`])
 */
export class BoxSelection {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Selected boxes to spend as transaction inputs
     */
    boxes(): ErgoBoxes;
    /**
     * Selected boxes to use as change
     */
    change(): ErgoBoxAssetsDataList;
    /**
     * Create a selection to easily inject custom selection algorithms
     */
    constructor(boxes: ErgoBoxes, change: ErgoBoxAssetsDataList);
}

/**
 * Box value in nanoERGs with bound checks
 */
export class BoxValue {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Recommended (safe) minimal box value to use in case box size estimation is unavailable.
     * Allows box size upto 2777 bytes with current min box value per byte of 360 nanoERGs
     */
    static SAFE_USER_MIN(): BoxValue;
    /**
     * Number of units inside one ERGO (i.e. one ERG using nano ERG representation)
     */
    static UNITS_PER_ERGO(): I64;
    /**
     * Get value as signed 64-bit long (I64)
     */
    as_i64(): I64;
    /**
     * Create from i64 with bounds check
     */
    static from_i64(v: I64): BoxValue;
    /**
     * big-endian byte array representation
     */
    to_bytes(): Uint8Array;
}

/**
 * CommitmentHint
 */
export class CommitmentHint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * Ergo constant(evaluated) values
 */
export class Constant {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns the debug representation of the value of the constant
     */
    dbg_inner(): string;
    /**
     * Returns the debug representation of the type of the constant
     */
    dbg_tpe(): string;
    /**
     * Decode from Base16-encoded ErgoTree serialized value
     */
    static decode_from_base16(base16_bytes_str: string): Constant;
    /**
     * Encode as Base16-encoded ErgoTree serialized value or return an error if serialization
     * failed
     */
    encode_to_base16(): string;
    /**
     * Create BigInt constant from byte array (signed bytes bit-endian)
     */
    static from_bigint_signed_bytes_be(num: Uint8Array): Constant;
    /**
     * Create from byte array
     */
    static from_byte_array(v: Uint8Array): Constant;
    /**
     * Create `Coll[Coll[Byte]]` from array byte array
     */
    static from_coll_coll_byte(arr: Uint8Array[]): Constant;
    /**
     * Parse raw `EcPoint` value from bytes and make `ProveDlog` constant
     */
    static from_ecpoint_bytes(bytes: Uint8Array): Constant;
    /**
     * Parse raw `EcPoint` value from bytes and make `GroupElement` constant
     */
    static from_ecpoint_bytes_group_element(bytes: Uint8Array): Constant;
    /**
     * Create from ErgoBox value
     */
    static from_ergo_box(v: ErgoBox): Constant;
    /**
     * Create `Coll[Int]` from integer array
     */
    static from_i32_array(arr: Int32Array): Constant;
    /**
     * Create from i32 value
     */
    static from_i32(v: number): Constant;
    /**
     * Create from i64
     */
    static from_i64(v: I64): Constant;
    /**
     * Create `Coll[Long]` from string array
     */
    static from_i64_str_array(arr: any[]): Constant;
    /**
     * Create a Constant from JS value
     * JS types are converted to the following Ergo types:
     * Number -> Int,
     * String -> Long,
     * BigInt -> BigInt,
     * use array_as_tuple() to encode Ergo tuples
     */
    static from_js(value: any): Constant;
    /**
     * Create `(Coll[Byte], Coll[Byte])` tuple Constant
     */
    static from_tuple_coll_bytes(bytes1: Uint8Array, bytes2: Uint8Array): Constant;
    /**
     * Create `(Long, Long)` tuple Constant
     */
    static from_tuple_i64(l1: I64, l2: I64): Constant;
    /**
     * Create from UnsignedBigInt value
     */
    static from_u256(v: UnsignedBigInt): Constant;
    /**
     * Returns true if constant value is Unit
     */
    is_unit(): boolean;
    /**
     * Returns serialized bytes or fails with error if Constant cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
    /**
     * Extract byte array, returning error if wrong type
     */
    to_byte_array(): Uint8Array;
    /**
     * Extract `Coll[Coll[Byte]]` as array of byte arrays
     */
    to_coll_coll_byte(): Uint8Array[];
    /**
     * Extract ErgoBox value, returning error if wrong type
     */
    to_ergo_box(): ErgoBox;
    /**
     * Extract `Coll[Int]` as integer array
     */
    to_i32_array(): Int32Array;
    /**
     * Extract i32 value, returning error if wrong type
     */
    to_i32(): number;
    /**
     * Extract i64 value, returning error if wrong type
     */
    to_i64(): I64;
    /**
     * Extract `Coll[Long]` as string array
     */
    to_i64_str_array(): any[];
    /**
     * Extract JS value from Constant
     * Ergo types are converted to the following JS types:
     * Byte -> Number,
     * Short -> Number,
     * Int -> Number,
     * Long -> String,
     * BigInt -> BigInt,
     * Ergo tuples are encoded as arrays
     */
    to_js(): any;
    /**
     * Extract `(Coll[Byte], Coll[Byte])` tuple from Constant as array of Uint8Array
     */
    to_tuple_coll_bytes(): Uint8Array[];
    /**
     * Create `(Int, Int)` tuple Constant
     */
    to_tuple_i32(): any[];
    /**
     * Extract `(Long, Long)` tuple from Constant as array of strings
     */
    to_tuple_i64(): any[];
    /**
     * Create Constant with Unit value
     */
    static unit(): Constant;
}

/**
 * User-defined variables to be put into context
 */
export class ContextExtension {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * get from map or fail if key is missing
     */
    get(key: number): Constant;
    /**
     * Returns all keys in the map
     */
    keys(): Uint8Array;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create new ContextExtension instance
     */
    constructor();
    /**
     * Set the supplied pair in the ContextExtension
     */
    set_pair(id: number, value: Constant): void;
    /**
     * Returns serialized bytes or fails with error if ContextExtension cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
}

/**
 * Defines the contract(script) that will be guarding box contents
 */
export class Contract {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the ErgoTree of the contract
     */
    ergo_tree(): ErgoTree;
    /**
     * Create new contract from ErgoTree
     */
    static new(ergo_tree: ErgoTree): Contract;
    /**
     * create new contract that allow spending of the guarded box by a given recipient ([`Address`])
     */
    static pay_to_address(recipient: Address): Contract;
}

/**
 * Inputs, that are used to enrich script context, but won't be spent by the transaction
 */
export class DataInput {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get box id
     */
    box_id(): BoxId;
    /**
     * Parse box id (32 byte digest) from base16-encoded string
     */
    constructor(box_id: BoxId);
}

/**
 * DataInput collection
 */
export class DataInputs {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds an elements to the collection
     */
    add(elem: DataInput): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): DataInput;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty DataInputs
     */
    constructor();
}

/**
 * According to
 * BIP-44 <https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki>
 * and EIP-3 <https://github.com/ergoplatform/eips/blob/master/eip-0003.md>
 */
export class DerivationPath {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns the length of the derivation path
     */
    depth(): number;
    /**
     * Create a derivation path from a formatted string
     * E.g "m/44'/429'/0'/0/1"
     */
    static from_string(path: string): DerivationPath;
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
     */
    ledger_bytes(): Uint8Array;
    /**
     * Create root derivation path
     */
    static master_path(): DerivationPath;
    /**
     * Create derivation path for a given account index (hardened) and address indices
     * `m / 44' / 429' / acc' / 0 / address[0] / address[1] / ...`
     * or `m / 44' / 429' / acc' / 0` if address indices are empty
     * change is always zero according to EIP-3
     * acc is expected as a 31-bit value (32th bit should not be set)
     */
    static new(acc: number, address_indices: Uint32Array): DerivationPath;
    /**
     * Returns a new path with the last element of the deriviation path being increased, e.g. m/1/2 -> m/1/3
     * Returns an empty path error if the path is empty (master node)
     */
    next(): DerivationPath;
    /**
     * String representation of derivation path
     * E.g m/44'/429'/0'/0/1
     */
    toString(): string;
}

/**
 * Ergo box, that is taking part in some transaction on the chain
 * Differs with [`ErgoBoxCandidate`] by added transaction id and an index in the input of that transaction
 */
export class ErgoBox {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get box id
     */
    box_id(): BoxId;
    /**
     * Get box creation height
     */
    creation_height(): number;
    /**
     * Get ergo tree for box
     */
    ergo_tree(): ErgoTree;
    /**
     * Create ErgoBox from ErgoBoxCandidate by adding transaction id
     * and index of the box in the transaction
     */
    static from_box_candidate(candidate: ErgoBoxCandidate, tx_id: TxId, index: number): ErgoBox;
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     */
    static from_json(json: string): ErgoBox;
    /**
     * Index of this box in transaction outputs
     */
    index(): number;
    /**
     * make a new box with:
     * `value` - amount of money associated with the box
     * `contract` - guarding contract([`Contract`]), which should be evaluated to true in order
     * to open(spend) this box
     * `creation_height` - height when a transaction containing the box is created.
     * `tx_id` - transaction id in which this box was "created" (participated in outputs)
     * `index` - index (in outputs) in the transaction
     */
    constructor(value: BoxValue, creation_height: number, contract: Contract, tx_id: TxId, index: number, tokens: Tokens);
    /**
     * Returns value (ErgoTree constant) stored in the register or None if the register is empty or cannot be parsed
     */
    register_value(register_id: NonMandatoryRegisterId): Constant | undefined;
    /**
     * Serialized additional register as defined in ErgoBox serialization (registers count,
     * followed by every non-empyt register value serialized)
     */
    serialized_additional_registers(): Uint8Array;
    /**
     * Parses ErgoBox or fails with error
     */
    static sigma_parse_bytes(data: Uint8Array): ErgoBox;
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amounts encoding as strings)
     */
    to_js_eip12(): any;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
    /**
     * Get tokens for box
     */
    tokens(): Tokens;
    /**
     * Get id of transaction which created the box
     */
    tx_id(): TxId;
    /**
     * Get box value in nanoERGs
     */
    value(): BoxValue;
}

/**
 * Pair of <value, tokens> for an box
 */
export class ErgoBoxAssetsData {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create new instance
     */
    constructor(value: BoxValue, tokens: Tokens);
    /**
     * Tokens part of the box
     */
    tokens(): Tokens;
    /**
     * Value part of the box
     */
    value(): BoxValue;
}

/**
 * List of asset data for a box
 */
export class ErgoBoxAssetsDataList {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds an elements to the collection
     */
    add(elem: ErgoBoxAssetsData): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): ErgoBoxAssetsData;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty Tokens
     */
    constructor();
}

/**
 * ErgoBox candidate not yet included in any transaction on the chain
 */
export class ErgoBoxCandidate {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get box creation height
     */
    creation_height(): number;
    /**
     * Get ergo tree for box
     */
    ergo_tree(): ErgoTree;
    /**
     * Create a box with miner's contract and given value
     */
    static new_miner_fee_box(fee_amount: BoxValue, creation_height: number): ErgoBoxCandidate;
    /**
     * Returns value (ErgoTree constant) stored in the register or None if the register is empty or cannot be parsed
     */
    register_value(register_id: NonMandatoryRegisterId): Constant | undefined;
    /**
     * Serialized additional register as defined in ErgoBox serialization (registers count,
     * followed by every non-empyt register value serialized)
     */
    serialized_additional_registers(): Uint8Array;
    /**
     * Get tokens for box
     */
    tokens(): Tokens;
    /**
     * Get box value in nanoERGs
     */
    value(): BoxValue;
}

/**
 * ErgoBoxCandidate builder
 */
export class ErgoBoxCandidateBuilder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add given token id and token amount
     */
    add_token(token_id: TokenId, amount: TokenAmount): void;
    /**
     * Build the box candidate
     */
    build(): ErgoBoxCandidate;
    /**
     * Calculate serialized box size(in bytes)
     */
    calc_box_size_bytes(): number;
    /**
     * Calculate minimal box value for the current box serialized size(in bytes)
     */
    calc_min_box_value(): BoxValue;
    /**
     * Delete register value(make register empty) for the given register id (R4-R9)
     */
    delete_register_value(register_id: NonMandatoryRegisterId): void;
    /**
     * Get minimal value (per byte of the serialized box size)
     */
    min_box_value_per_byte(): number;
    /**
     * Mint token, as defined in <https://github.com/ergoplatform/eips/blob/master/eip-0004.md>
     * `token` - token id(box id of the first input box in transaction) and token amount,
     * `token_name` - token name (will be encoded in R4),
     * `token_desc` - token description (will be encoded in R5),
     * `num_decimals` - number of decimals (will be encoded in R6)
     */
    mint_token(token: Token, token_name: string, token_desc: string, num_decimals: number): void;
    /**
     * Create builder with required box parameters:
     * `value` - amount of money associated with the box
     * `contract` - guarding contract([`Contract`]), which should be evaluated to true in order
     * to open(spend) this box
     * `creation_height` - height when a transaction containing the box is created.
     * It should not exceed height of the block, containing the transaction with this box.
     */
    constructor(value: BoxValue, contract: Contract, creation_height: number);
    /**
     * Returns register value for the given register id (R4-R9), or None if the register is empty
     */
    register_value(register_id: NonMandatoryRegisterId): Constant | undefined;
    /**
     * Set minimal value (per byte of the serialized box size)
     */
    set_min_box_value_per_byte(new_min_value_per_byte: number): void;
    /**
     * Set register with a given id (R4-R9) to the given value
     */
    set_register_value(register_id: NonMandatoryRegisterId, value: Constant): void;
    /**
     * Set new box value
     */
    set_value(new_value: BoxValue): void;
    /**
     * Get box value
     */
    value(): BoxValue;
}

/**
 * Collection of ErgoBoxCandidates
 */
export class ErgoBoxCandidates {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add an element to the collection
     */
    add(b: ErgoBoxCandidate): void;
    /**
     * sometimes it's useful to keep track of an empty list
     * but keep in mind Ergo transactions need at least 1 output
     */
    static empty(): ErgoBoxCandidates;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): ErgoBoxCandidate;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create new outputs
     */
    constructor(box_candidate: ErgoBoxCandidate);
}

/**
 * Collection of ErgoBox'es
 */
export class ErgoBoxes {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add an element to the collection
     */
    add(b: ErgoBox): void;
    /**
     * Empty ErgoBoxes
     */
    static empty(): ErgoBoxes;
    /**
     * parse ErgoBox array from json
     */
    static from_boxes_json(json_vals: any[]): ErgoBoxes;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): ErgoBox;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create new collection with one element
     */
    constructor(b: ErgoBox);
}

/**
 * Blockchain state (last headers, etc.)
 */
export class ErgoStateContext {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create new context from pre-header
     */
    constructor(pre_header: PreHeader, headers: BlockHeaders, parameters: Parameters);
}

/**
 * The root of ErgoScript IR. Serialized instances of this class are self sufficient and can be passed around.
 */
export class ErgoTree {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns constants number as stored in serialized ErgoTree or error if the parsing of
     * constants is failed
     */
    constants_len(): number;
    /**
     * Decode from base16 encoded serialized ErgoTree
     */
    static from_base16_bytes(s: string): ErgoTree;
    /**
     * Decode from encoded serialized ErgoTree
     */
    static from_bytes(data: Uint8Array): ErgoTree;
    /**
     * Returns constant with given index (as stored in serialized ErgoTree)
     * or None if index is out of bounds
     * or error if constants parsing were failed
     */
    get_constant(index: number): Constant | undefined;
    /**
     * Returns pretty printed tree
     */
    pretty_print(): string;
    /**
     * Returns serialized bytes or fails with error if ErgoTree cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
    /**
     * Serialized proposition expression of SigmaProp type with
     * ConstantPlaceholder nodes instead of Constant nodes
     */
    template_bytes(): Uint8Array;
    /**
     * Returns Base16-encoded serialized bytes
     */
    to_base16_bytes(): string;
    /**
     * Consumes the calling ErgoTree and returns new ErgoTree with a new constant value
     * for a given index in constants list (as stored in serialized ErgoTree), or an error.
     * After the call the calling ErgoTree will be null.
     */
    with_constant(index: number, constant: Constant): ErgoTree;
}

/**
 * Extented public key implemented according to BIP-32
 */
export class ExtPubKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Chain code of the `ExtPubKey`
     */
    chain_code(): Uint8Array;
    /**
     * Soft derivation of the child public key with a given index
     * index is expected to be a 31-bit value(32th bit should not be set)
     */
    child(index: number): ExtPubKey;
    /**
     * Derive a new extended pub key from the derivation path
     */
    derive(path: DerivationPath): ExtPubKey;
    /**
     * Create ExtPubKey from public key bytes (from SEC1 compressed), chain code and derivation
     * path
     */
    static new(public_key_bytes: Uint8Array, chain_code: Uint8Array, derivation_path: DerivationPath): ExtPubKey;
    /**
     * Public key bytes of the `ExtPubKey`
     */
    pub_key_bytes(): Uint8Array;
    /**
     * Create address (P2PK) from this extended public key
     */
    to_address(): Address;
}

/**
 * Extented secret key implemented according to BIP-32
 */
export class ExtSecretKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Derive a new extended secret key from the provided index
     * The index is in the form of soft or hardened indices
     * For example: 4 or 4' respectively
     */
    child(index: string): ExtSecretKey;
    /**
     * Derive a new extended secret key from the derivation path
     */
    derive(path: DerivationPath): ExtSecretKey;
    /**
     * Derive root extended secret key
     */
    static derive_master(seed_bytes: Uint8Array): ExtSecretKey;
    /**
     * Create ExtSecretKey from secret key bytes, chain code and derivation path
     */
    static new(secret_key_bytes: Uint8Array, chain_code: Uint8Array, derivation_path: DerivationPath): ExtSecretKey;
    /**
     * Derivation path associated with the ext secret key
     */
    path(): DerivationPath;
    /**
     * The extended public key associated with this secret key
     */
    public_key(): ExtPubKey;
    /**
     * The bytes of the associated secret key
     */
    secret_key_bytes(): Uint8Array;
}

/**
 * HintsBag
 */
export class HintsBag {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add commitment hint to the bag
     */
    add_commitment(hint: CommitmentHint): void;
    /**
     * Empty HintsBag
     */
    static empty(): HintsBag;
    /**
     * Get commitment
     */
    get(index: number): CommitmentHint;
    /**
     * Length of HintsBag
     */
    len(): number;
}

/**
 * Wrapper for i64 for JS/TS because JS Number can only represent 53 bits
 * see <https://stackoverflow.com/questions/17320706/javascript-long-integer>
 */
export class I64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the value as JS number (64-bit float)
     */
    as_num(): number;
    /**
     * Addition with overflow check
     */
    checked_add(other: I64): I64;
    /**
     * Create from a standard rust string representation
     */
    static from_str(string: string): I64;
    /**
     * String representation of the value for use from environments that don't support i64
     */
    to_str(): string;
}

/**
 * Signed inputs used in signed transactions
 */
export class Input {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get box id
     */
    box_id(): BoxId;
    /**
     * Get the spending proof
     */
    spending_proof(): ProverResult;
}

/**
 * Collection of signed inputs
 */
export class Inputs {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): Input;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty Inputs
     */
    constructor();
}

/**
 * A level node in a merkle proof
 */
export class LevelNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates a new LevelNode from a 32 byte hash and side that the node belongs on in the tree. Fails if the digest is not 32 bytes
     */
    static new(hash: Uint8Array, side: number): LevelNode;
    /**
     * Returns the associated digest (hash) with this node. Returns an empty array if there's no hash
     */
    readonly digest: Uint8Array;
    /**
     * Returns the associated side with this node (0 = Left, 1 = Right)
     */
    readonly side: number;
}

/**
 * A MerkleProof type. Given leaf data and levels (bottom-upwards), the root hash can be computed and validated
 */
export class MerkleProof {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds a new node to the MerkleProof above the current nodes
     */
    add_node(level: LevelNode): void;
    /**
     * Creates a new merkle proof with given leaf data and level data (bottom-upwards)
     * You can verify it against a Blakeb256 root hash by using [`Self::valid()`]
     * Add a node by using [`Self::add_node()`]
     * Each digest on the level must be exactly 32 bytes
     */
    static new(leaf_data: Uint8Array): MerkleProof;
    /**
     * Validates the Merkle proof against the root hash
     */
    valid(expected_root: Uint8Array): boolean;
}

/**
 * helper methods to get the fee address for various networks
 */
export class MinerAddress {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Miner fee Base58 encoded P2S address on mainnet
     */
    static mainnet_fee_address(): string;
    /**
     * Miner fee Base58 encoded P2S address on testnet
     */
    static testnet_fee_address(): string;
}

/**
 * Mnemonic
 */
export class Mnemonic {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Convert a mnemonic phrase into a mnemonic seed
     * mnemonic_pass is optional and is used to salt the seed
     */
    static to_seed(mnemonic_phrase: string, mnemonic_pass: string): Uint8Array;
}

/**
 * Combination of an Address with a network
 * These two combined together form a base58 encoding
 */
export class NetworkAddress {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get address without network information
     */
    address(): Address;
    /**
     * Decode (base58) a NetworkAddress (address + network prefix) from string
     */
    static from_base58(s: string): NetworkAddress;
    /**
     * Decode from a serialized address
     */
    static from_bytes(data: Uint8Array): NetworkAddress;
    /**
     * Network for the address
     */
    network(): NetworkPrefix;
    /**
     * create a new NetworkAddress(address + network prefix) for a given network type
     */
    static new(network: NetworkPrefix, address: Address): NetworkAddress;
    /**
     * Encode (base58) address
     */
    to_base58(): string;
    /**
     * Encode address as serialized bytes
     */
    to_bytes(): Uint8Array;
}

/**
 * Network type
 */
export enum NetworkPrefix {
    /**
     * Mainnet
     */
    Mainnet = 0,
    /**
     * Testnet
     */
    Testnet = 16,
}

/**
 * A structure representing NiPoPow proof.
 */
export class NipopowProof {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     */
    static from_json(json: string): NipopowProof;
    /**
     * Implementation of the ≥ algorithm from [`KMZ17`], see Algorithm 4
     *
     * [`KMZ17`]: https://fc20.ifca.ai/preproceedings/74.pdf
     */
    is_better_than(that: NipopowProof): boolean;
    /**
     * Get suffix head
     */
    suffix_head(): PoPowHeader;
    /**
     * JSON representation as text
     */
    to_json(): string;
}

/**
 * A verifier for PoPoW proofs. During its lifetime, it processes many proofs with the aim of
 * deducing at any given point what is the best (sub)chain rooted at the specified genesis.
 */
export class NipopowVerifier {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns chain of `BlockHeader`s from the best proof.
     */
    best_chain(): BlockHeaders;
    /**
     * Return best proof
     */
    best_proof(): NipopowProof | undefined;
    /**
     * Create new instance
     */
    constructor(genesis_block_id: BlockId);
    /**
     * Process given proof
     */
    process(new_proof: NipopowProof): void;
}

/**
 * newtype for box registers R4 - R9
 */
export enum NonMandatoryRegisterId {
    /**
     * id for R4 register
     */
    R4 = 4,
    /**
     * id for R5 register
     */
    R5 = 5,
    /**
     * id for R6 register
     */
    R6 = 6,
    /**
     * id for R7 register
     */
    R7 = 7,
    /**
     * id for R8 register
     */
    R8 = 8,
    /**
     * id for R9 register
     */
    R9 = 9,
}

/**
 * Blockchain parameters
 */
export class Parameters {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get current block version
     */
    block_version(): number;
    /**
     * Validation cost per data input
     */
    data_input_cost(): number;
    /**
     * Return default blockchain parameters that were set at genesis
     */
    static default_parameters(): Parameters;
    /**
     * Validation cost per one transaction input
     */
    input_cost(): number;
    /**
     * Maximum total computation cost in a block
     */
    max_block_cost(): number;
    /**
     * Maximum size of transactions size in a block
     */
    max_block_size(): number;
    /**
     * Minimum value per byte an output must have to not be considered dust
     */
    min_value_per_byte(): number;
    /**
     * Validation cost per one output
     */
    output_cost(): number;
    /**
     * Cost of storing 1 byte per Storage Period of block chain
     */
    storage_fee_factor(): number;
    /**
     * Cost of accessing a single token
     */
    token_access_cost(): number;
}

/**
 * PoPowHeader structure. Represents the block header and unpacked interlinks
 */
export class PoPowHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Validates interlinks merkle root with compact merkle multiproof. See [`PoPowHeader::interlinks_proof`] for BatchMerkleProof access
     */
    check_interlinks_proof(): boolean;
    /**
     * Returns block header
     */
    header(): BlockHeader;
    /**
     * Returns block height for Header
     */
    height(): number;
    /**
     * Returns Block ID for Header
     */
    id(): BlockId;
    /**
     * Returns interlinks for PoPowHeader
     */
    interlinks(): any;
    /**
     * Returns interlinks proof [`crate::batchmerkleproof::BatchMerkleProof`]
     */
    interlinks_proof(): BatchMerkleProof;
}

/**
 * Block header with the current `spendingTransaction`, that can be predicted
 * by a miner before it's formation
 */
export class PreHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create using data from block header
     */
    static from_block_header(block_header: BlockHeader): PreHeader;
}

/**
 * Propositions list(public keys)
 */
export class Propositions {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adding new proposition
     */
    add_proposition_from_byte(proposition: Uint8Array): void;
    /**
     * Create empty proposition holder
     */
    constructor();
}

/**
 * Proof of correctness of tx spending
 */
export class ProverResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get extension
     */
    extension(): ContextExtension;
    /**
     * Get proof
     */
    proof(): Uint8Array;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
}

/**
 * Represent `reduced` transaction, i.e. unsigned transaction where each unsigned input
 * is augmented with ReducedInput which contains a script reduction result.
 * After an unsigned transaction is reduced it can be signed without context.
 * Thus, it can be serialized and transferred for example to Cold Wallet and signed
 * in an environment where secrets are known.
 * see EIP-19 for more details -
 * <https://github.com/ergoplatform/eips/blob/f280890a4163f2f2e988a0091c078e36912fc531/eip-0019.md>
 */
export class ReducedTransaction {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     */
    static from_json(json: string): ReducedTransaction;
    /**
     * Returns `reduced` transaction, i.e. unsigned transaction where each unsigned input
     * is augmented with ReducedInput which contains a script reduction result.
     */
    static from_unsigned_tx(unsigned_tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes, state_context: ErgoStateContext): ReducedTransaction;
    /**
     * Parses ReducedTransaction or fails with error
     */
    static sigma_parse_bytes(data: Uint8Array): ReducedTransaction;
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
    /**
     * Returns the unsigned transaction
     */
    unsigned_tx(): UnsignedTransaction;
}

/**
 * Secret key for the prover
 */
export class SecretKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse Diffie-Hellman tuple secret key from bytes.
     * secret is expected as SEC-1-encoded scalar of 32 bytes,
     * g,h,u,v are expected as 33-byte compressed points
     */
    static dht_from_bytes(secret: Uint8Array, g: Uint8Array, h: Uint8Array, u: Uint8Array, v: Uint8Array): SecretKey;
    /**
     * Parse dlog secret key from bytes (SEC-1-encoded scalar)
     */
    static dlog_from_bytes(bytes: Uint8Array): SecretKey;
    /**
     * Parse secret key from bytes (expected 32 bytes for Dlog, 32(secret)+33(g)+33(h)+33(u)+33(v)=164 bytes for DHT)
     * secret is expected as SEC-1-encoded scalar of 32 bytes,
     * g,h,u,v are expected as 33-byte compressed points
     */
    static from_bytes(bytes: Uint8Array): SecretKey;
    /**
     * Parse secret key from JSON string (Dlog expected as base16-encoded bytes, DHT in node REST API format)
     */
    static from_json(json_str: string): SecretKey;
    /**
     * Address (encoded public image)
     */
    get_address(): Address;
    /**
     * generate random key
     */
    static random_dlog(): SecretKey;
    /**
     * Serialized secret key (32 bytes for Dlog, 32(secret)+33(g)+33(h)+33(u)+33(v)=164 bytes for DHT)
     * DHT format is the same as in from_bytes
     */
    to_bytes(): Uint8Array;
    /**
     * Encode secret key to JSON string (Dlog as base16-encoded bytes, DHT in node REST API format)
     */
    to_json(): string;
}

/**
 * SecretKey collection
 */
export class SecretKeys {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds an elements to the collection
     */
    add(elem: SecretKey): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): SecretKey;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty SecretKeys
     */
    constructor();
}

/**
 * Naive box selector, collects inputs until target balance is reached
 */
export class SimpleBoxSelector {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create empty SimpleBoxSelector
     */
    constructor();
    /**
     * Selects inputs to satisfy target balance and tokens.
     * `inputs` - available inputs (returns an error, if empty),
     * `target_balance` - coins (in nanoERGs) needed,
     * `target_tokens` - amount of tokens needed.
     * Returns selected inputs and box assets(value+tokens) with change.
     */
    select(inputs: ErgoBoxes, target_balance: BoxValue, target_tokens: Tokens): BoxSelection;
}

/**
 * Token represented with token id paired with it's amount
 */
export class Token {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get token amount
     */
    amount(): TokenAmount;
    /**
     * Get token id
     */
    id(): TokenId;
    /**
     * Create a token with given token id and amount
     */
    constructor(token_id: TokenId, amount: TokenAmount);
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with token amount encoding as string)
     */
    to_js_eip12(): any;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
}

/**
 * Token amount with bound checks
 */
export class TokenAmount {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get value as signed 64-bit long (I64)
     */
    as_i64(): I64;
    /**
     * Create from i64 with bounds check
     */
    static from_i64(v: I64): TokenAmount;
    /**
     * big-endian byte array representation
     */
    to_bytes(): Uint8Array;
}

/**
 * Token id (32 byte digest)
 */
export class TokenId {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns byte array (32 bytes)
     */
    as_bytes(): Uint8Array;
    /**
     * Create token id from ergo box id (32 byte digest)
     */
    static from_box_id(box_id: BoxId): TokenId;
    /**
     * Parse token id (32 byte digest) from base16-encoded string
     */
    static from_str(str: string): TokenId;
    /**
     * Base16 encoded string
     */
    to_str(): string;
}

/**
 * Array of tokens
 */
export class Tokens {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds an elements to the collection
     */
    add(elem: Token): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): Token;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty Tokens
     */
    constructor();
}

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
export class Transaction {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Data inputs for transaction
     */
    data_inputs(): DataInputs;
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     */
    static from_json(json: string): Transaction;
    /**
     * Create Transaction from UnsignedTransaction and an array of proofs in the same order as
     * UnsignedTransaction.inputs with empty proof indicated with empty byte array
     */
    static from_unsigned_tx(unsigned_tx: UnsignedTransaction, proofs: Uint8Array[]): Transaction;
    /**
     * Get id for transaction
     */
    id(): TxId;
    /**
     * Inputs for transaction
     */
    inputs(): Inputs;
    /**
     * Create new transaction
     */
    constructor(inputs: Inputs, data_inputs: DataInputs, outputs: ErgoBoxCandidates);
    /**
     * Output candidates for transaction
     */
    output_candidates(): ErgoBoxCandidates;
    /**
     * Returns ErgoBox's created from ErgoBoxCandidate's with tx id and indices
     */
    outputs(): ErgoBoxes;
    /**
     * Parses Transaction or fails with error
     */
    static sigma_parse_bytes(data: Uint8Array): Transaction;
    /**
     * Returns serialized bytes or fails with error if cannot be serialized
     */
    sigma_serialize_bytes(): Uint8Array;
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amount encoding as strings)
     */
    to_js_eip12(): any;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
    /**
     * Check the signature of the transaction's input corresponding
     * to the given input box, guarded by P2PK script
     */
    verify_p2pk_input(input_box: ErgoBox): boolean;
}

/**
 * TransactionHintsBag
 */
export class TransactionHintsBag {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adding hints for input
     */
    add_hints_for_input(index: number, hints_bag: HintsBag): void;
    /**
     * Outputting HintsBag corresponding for an input index
     */
    all_hints_for_input(index: number): HintsBag;
    /**
     * Empty TransactionHintsBag
     */
    static empty(): TransactionHintsBag;
    /**
     * Parse from JSON object (node format)
     */
    static from_json(json: string): TransactionHintsBag;
    /**
     * Return JSON object (node format)
     */
    to_json(): any;
}

/**
 * Unsigned transaction builder
 */
export class TxBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Suggested transaction fee (semi-default value used across wallets and dApps as of Oct 2020)
     */
    static SUGGESTED_TX_FEE(): BoxValue;
    /**
     * Get box selection
     */
    box_selection(): BoxSelection;
    /**
     * Build the unsigned transaction
     */
    build(): UnsignedTransaction;
    /**
     * Get change address
     */
    change_address(): Address;
    /**
     * Get current height
     */
    current_height(): number;
    /**
     * Get data inputs
     */
    data_inputs(): DataInputs;
    /**
     * Get fee amount
     */
    fee_amount(): BoxValue;
    /**
     * Creates new TxBuilder
     * `box_selection` - selected input boxes (via [`super::box_selector`])
     * `output_candidates` - output boxes to be "created" in this transaction,
     * `current_height` - chain height that will be used in additionally created boxes (change, miner's fee, etc.),
     * `fee_amount` - miner's fee,
     * `change_address` - change (inputs - outputs) will be sent to this address,
     * will be given to miners,
     */
    static new(box_selection: BoxSelection, output_candidates: ErgoBoxCandidates, current_height: number, fee_amount: BoxValue, change_address: Address): TxBuilder;
    /**
     * Get outputs EXCLUDING fee and change
     */
    output_candidates(): ErgoBoxCandidates;
    /**
     * Set context extension for a given input
     */
    set_context_extension(box_id: BoxId, context_extension: ContextExtension): void;
    /**
     * Set transaction's data inputs
     */
    set_data_inputs(data_inputs: DataInputs): void;
    /**
     * Permits the burn of the given token amount, i.e. allows this token amount to be omitted in the outputs
     */
    set_token_burn_permit(tokens: Tokens): void;
}

/**
 * Transaction id
 */
export class TxId {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * convert a hex string into a TxId
     */
    static from_str(s: string): TxId;
    /**
     * get the tx id as bytes
     */
    to_str(): string;
    /**
     * Zero (empty) transaction id (to use as dummy value in tests)
     */
    static zero(): TxId;
}

/**
 * Unsigned 256-bit integer type
 */
export class UnsignedBigInt {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add two UnsignedBigInts. If the result overflows an exception will be raised
     */
    add(other: UnsignedBigInt): UnsignedBigInt;
    /**
     * Divide self by other. Returns an exception if other == 0
     */
    div(other: UnsignedBigInt): UnsignedBigInt;
    /**
     * Compare two UnsignedBigInts
     */
    eq(other: UnsignedBigInt): boolean;
    /**
     * Create UnsignedBigInt from str with given base
     */
    static from_str_radix(s: string, radix: number): UnsignedBigInt;
    /**
     * Compute (self + other) mod modulus. Returns an exception if modulus == 0
     */
    mod_add(other: UnsignedBigInt, modulus: UnsignedBigInt): UnsignedBigInt;
    /**
     * Compute modular inverse of self. Returns an exception if modulus == 0 or modular inverse does not exist
     */
    mod_inv(modulus: UnsignedBigInt): UnsignedBigInt;
    /**
     * Compute (self * other) mod modulus. Returns an exception if modulus == 0
     */
    mod_mul(other: UnsignedBigInt, modulus: UnsignedBigInt): UnsignedBigInt;
    /**
     * Compute (self - other) mod modulus. Returns an exception if modulus == 0
     */
    mod_sub(other: UnsignedBigInt, modulus: UnsignedBigInt): UnsignedBigInt;
    /**
     * Multiply self by other. If the result overflows an exception will be raised
     */
    mul(other: UnsignedBigInt): UnsignedBigInt;
    /**
     * Create a new UnsignedBigInt from Number or JS BigInt
     */
    constructor(number: any);
    /**
     * Compute (self mod modulus)
     */
    rem(modulus: UnsignedBigInt): UnsignedBigInt;
    /**
     * Subtract other from self. If the result overflows an exception will be raised
     */
    sub(other: UnsignedBigInt): UnsignedBigInt;
}

/**
 * Unsigned inputs used in constructing unsigned transactions
 */
export class UnsignedInput {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get box id
     */
    box_id(): BoxId;
    /**
     * Get extension
     */
    extension(): ContextExtension;
    /**
     * Create a new unsigned input from the provided box id
     * using an empty context extension
     */
    static from_box_id(box_id: BoxId): UnsignedInput;
    /**
     * Create new unsigned input instance from box id and extension
     */
    constructor(box_id: BoxId, ext: ContextExtension);
}

/**
 * Collection of unsigned signed inputs
 */
export class UnsignedInputs {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add an element to the collection
     */
    add(b: UnsignedInput): void;
    /**
     * Returns the element of the collection with a given index
     */
    get(index: number): UnsignedInput;
    /**
     * Returns the number of elements in the collection
     */
    len(): number;
    /**
     * Create empty UnsignedInputs
     */
    constructor();
}

/**
 * Unsigned (inputs without proofs) transaction
 */
export class UnsignedTransaction {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Data inputs for transaction
     */
    data_inputs(): DataInputs;
    /**
     * Returns distinct token id from output_candidates as array of byte arrays
     */
    distinct_token_ids(): Uint8Array[];
    /**
     * parse from JSON
     * supports Ergo Node/Explorer API and box values and token amount encoded as strings
     */
    static from_json(json: string): UnsignedTransaction;
    /**
     * Get id for transaction
     */
    id(): TxId;
    /**
     * Inputs for transaction
     */
    inputs(): UnsignedInputs;
    /**
     * Create a new unsigned transaction
     */
    constructor(inputs: UnsignedInputs, data_inputs: DataInputs, output_candidates: ErgoBoxCandidates);
    /**
     * Output candidates for transaction
     */
    output_candidates(): ErgoBoxCandidates;
    /**
     * JSON representation according to EIP-12 <https://github.com/ergoplatform/eips/pull/23>
     * (similar to [`Self::to_json`], but as JS object with box value and token amount encoding as strings)
     */
    to_js_eip12(): any;
    /**
     * JSON representation as text (compatible with Ergo Node/Explorer API, numbers are encoded as numbers)
     */
    to_json(): string;
    /**
     * Consumes the calling UnsignedTransaction and returns a new UnsignedTransaction containing
     * the ContextExtension in the provided input box id or returns an error if the input box cannot be found.
     * After the call the calling UnsignedTransaction will be null.
     */
    with_input_context_ext(input_id: BoxId, ext: ContextExtension): UnsignedTransaction;
}

/**
 * A collection of secret keys. This simplified signing by matching the secret keys to the correct inputs automatically.
 */
export class Wallet {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a secret to the wallets prover
     */
    add_secret(secret: SecretKey): void;
    /**
     * Create wallet instance loading secret key from mnemonic
     * Returns None if a DlogSecretKey cannot be parsed from the provided phrase
     */
    static from_mnemonic(mnemonic_phrase: string, mnemonic_pass: string): Wallet;
    /**
     * Create wallet using provided secret key
     */
    static from_secrets(secret: SecretKeys): Wallet;
    /**
     * Generate Commitments for unsigned tx
     */
    generate_commitments(_state_context: ErgoStateContext, tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes): TransactionHintsBag;
    /**
     * Generate Commitments for reduced Transaction
     */
    generate_commitments_for_reduced_transaction(reduced_tx: ReducedTransaction): TransactionHintsBag;
    /**
     * Sign an arbitrary message using a P2PK address
     */
    sign_message_using_p2pk(address: Address, message: Uint8Array): Uint8Array;
    /**
     * Sign a transaction:
     * `reduced_tx` - reduced transaction, i.e. unsigned transaction where for each unsigned input
     * added a script reduction result.
     */
    sign_reduced_transaction(reduced_tx: ReducedTransaction): Transaction;
    /**
     * Sign a multi signature reduced transaction:
     * `reduced_tx` - reduced transaction, i.e. unsigned transaction where for each unsigned input
     * added a script reduction result.
     * `tx_hints` - transaction hints bag corresponding to [`TransactionHintsBag`]
     */
    sign_reduced_transaction_multi(reduced_tx: ReducedTransaction, tx_hints: TransactionHintsBag): Transaction;
    /**
     * Sign a transaction:
     * `tx` - transaction to sign
     * `boxes_to_spend` - boxes corresponding to [`UnsignedTransaction::inputs`]
     * `data_boxes` - boxes corresponding to [`UnsignedTransaction::data_inputs`]
     */
    sign_transaction(_state_context: ErgoStateContext, tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes): Transaction;
    /**
     * Sign a multi signature transaction:
     * `tx` - transaction to sign
     * `boxes_to_spend` - boxes corresponding to [`UnsignedTransaction::inputs`]
     * `data_boxes` - boxes corresponding to [`UnsignedTransaction::data_inputs`]
     * `tx_hints` - transaction hints bag corresponding to [`TransactionHintsBag`]
     */
    sign_transaction_multi(_state_context: ErgoStateContext, tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes, tx_hints: TransactionHintsBag): Transaction;
    /**
     * Sign a given tx input
     */
    sign_tx_input(input_idx: number, state_context: ErgoStateContext, tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes): Input;
    /**
     * Sign a given multi-signature tx input
     */
    sign_tx_input_multi(input_idx: number, state_context: ErgoStateContext, tx: UnsignedTransaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes, tx_hints: TransactionHintsBag): Input;
}

/**
 * Encode a JS array as an Ergo tuple.
 */
export function array_as_tuple(items: any[]): any;

/**
 * Decodes a base16 string into an array of bytes
 */
export function base16_decode(data: string): Uint8Array;

/**
 * Extracting hints form singed(invalid) Transaction
 */
export function extract_hints(signed_transaction: Transaction, state_context: ErgoStateContext, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes, real_propositions: Propositions, simulated_propositions: Propositions): TransactionHintsBag;

/**
 * Verify transaction
 */
export function validate_tx(tx: Transaction, state_context: ErgoStateContext, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes): void;

/**
 * Verify that the signature is presented to satisfy SigmaProp conditions.
 */
export function verify_signature(address: Address, message: Uint8Array, signature: Uint8Array): boolean;

/**
 * Verify transaction input's proof
 */
export function verify_tx_input_proof(input_idx: number, state_context: ErgoStateContext, tx: Transaction, boxes_to_spend: ErgoBoxes, data_boxes: ErgoBoxes): boolean;
