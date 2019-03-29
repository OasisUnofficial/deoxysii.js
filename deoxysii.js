// Copyright (c) 2019 Oasis Labs Inc. <info@oasislabs.com>
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
// BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

var aes = require('aes');
var uint32 = require('uint32');
var timingSafeEqual = require('crypto').timingSafeEqual;
var unsafe = require('./unsafe');

const KeySize = 32;
const NonceSize = 15;
const TagSize = 16;

const stkSize = 16;
const rounds = 16;
const blockSize = 16;
const tweakSize = 16;

const prefixADBlock = 0x02;
const prefixADFinal = 0x06;
const prefixMsgBlock = 0x00;
const prefixMsgFinal = 0x04;
const prefixTag = 0x01;
const prefixShift = 4;

function xorBytes(dst, a, b, n) {
	for (let i = 0; i < n; i++) {
		dst[i] = a[i] ^ b[i];
	}
}

//
// TWEAKEY routines
//

const rcons = [
	0x2f, 0x5e, 0xbc, 0x63, 0xc6, 0x97, 0x35, 0x6a,
	0xd4, 0xb3, 0x7d, 0xfa, 0xef, 0xc5, 0x91, 0x39,
	0x72
];

function h(t) {
	const tmp = Buffer.from([
		t[7], t[0], t[13], t[10], t[11], t[4], t[1], t[14], t[15], t[8], t[5], t[2], t[3], t[12], t[9], t[6]
	]);
	tmp.copy(t);
}

function lfsr2(t) {
	for (let i = 0; i < stkSize; i++) {
		const x = t[i];

		const x7 = x >> 7;
		const x5 = (x >> 5) & 1;
		t[i] = (x << 1) | (x7 ^ x5);
	}
}

function lfsr3(t) {
	for (let i = 0; i < stkSize; i++) {
		const x = t[i];

		const x0 = x & 1;
		const x6 = (x >> 6) & 1;
		t[i] = (x >> 1) | ((x0 ^ x6) << 7);
	}
}

function xorRC(t, i) {
	t[0] ^= 1;
	t[1] ^= 2;
	t[2] ^= 4;
	t[3] ^= 8;
	t[4] ^= rcons[i];
	t[5] ^= rcons[i];
	t[6] ^= rcons[i];
	t[7] ^= rcons[i];
}

function stkDeriveK(key, derivedKs) {
	let tk2 = Buffer.from(key.slice(16, 32));
	let tk3	= Buffer.from(key.slice(0, 16));

	xorBytes(derivedKs[0], tk2, tk3, stkSize);
	xorRC(derivedKs[0], 0);

	for (let i = 1; i <= rounds; i++) {
		lfsr2(tk2);
		h(tk2);
		lfsr3(tk3);
		h(tk3);

		xorBytes(derivedKs[i], tk2, tk3, stkSize);
		xorRC(derivedKs[i], i);
	}
}

function deriveSubTweakKeys(stks, derivedKs, tweak) {
	let tk1 = Buffer.from(tweak);

	xorBytes(stks[0], derivedKs[0], tk1, stkSize);

	for (let i = 1; i <= rounds; i++) {
		h(tk1);
		xorBytes(stks[i], derivedKs[i], tk1, stkSize);
	}
}

function newStks() {
	let stks = [];
	for (let i = 0; i <= rounds; i++) {
		stks.push(Buffer.alloc(16));
	}
	return stks;
}

//
// Deoxys-BC-384
//

class implCt32 {
	static bcEncrypt(ciphertext, derivedKs, tweak, plaintext) {
		let stks = newStks();
		deriveSubTweakKeys(stks, derivedKs, tweak);

		let q = aes.newQ(), stk = aes.newQ();
		aes.load4xU32(q, plaintext);
		aes.load4xU32(stk, stks[0]);
		aes.addRoundKey(q, stk);

		for (let i = 1; i <= rounds; i++) {
			aes.subBytes(q);
			aes.shiftRows(q);
			aes.mixColumns(q);

			aes.load4xU32(stk, stks[i]);
			aes.addRoundKey(q, stk);
		}

		aes.store4xU32(ciphertext, q);
	}

	static bcKeystreamx2(ciphertext, derivedKs, tweaks, nonce) {
		let stks = [ newStks(), newStks() ];
		for (let i = 0; i < 2; i++) {
			deriveSubTweakKeys(stks[i], derivedKs, tweaks[i]);
		}

		let q = aes.newQ(), stk = aes.newQ();
		aes.rkeyOrtho(q, nonce);
		aes.load8xU32(stk, stks[0][0], stks[1][0]);
		aes.addRoundKey(q, stk);

		for (let i = 1; i <= rounds; i++) {
			aes.subBytes(q);
			aes.shiftRows(q);
			aes.mixColumns(q);

			aes.load8xU32(stk, stks[0][i], stks[1][i]);
			aes.addRoundKey(q, stk);
		}

		aes.store8xU32(ciphertext.slice(0, 16), ciphertext.slice(16, 32), q);
	}

	static bcTagx1(tag, derivedKs, tweak, plaintext) {
		let stks = newStks();
		deriveSubTweakKeys(stks, derivedKs, tweak);

		let q = aes.newQ(), stk = aes.newQ();
		aes.load4xU32(q, plaintext);
		aes.load4xU32(stk, stks[0]);
		aes.addRoundKey(q, stk);

		for (let i = 1; i <= rounds; i++) {
			aes.subBytes(q);
			aes.shiftRows(q);
			aes.mixColumns(q);

			aes.load4xU32(stk, stks[i]);
			aes.addRoundKey(q, stk);
		}

		let tag0 = tag.readUInt32LE(0);
		let tag1 = tag.readUInt32LE(4);
		let tag2 = tag.readUInt32LE(8);
		let tag3 = tag.readUInt32LE(12);

		aes.ortho(q);
		tag0 = uint32.xor(tag0, q[0]);
		tag1 = uint32.xor(tag1, q[2]);
		tag2 = uint32.xor(tag2, q[4]);
		tag3 = uint32.xor(tag3, q[6]);

		tag.writeUInt32LE(tag0, 0);
		tag.writeUInt32LE(tag1, 4);
		tag.writeUInt32LE(tag2, 8);
		tag.writeUInt32LE(tag3, 12);
	}

	static bcTagx2(tag, derivedKs, tweaks, plaintext) {
		let stks = [ newStks(), newStks() ];
		for (let i = 0; i < 2; i++) {
			deriveSubTweakKeys(stks[i], derivedKs, tweaks[i]);
		}

		let q = aes.newQ(), stk = aes.newQ();
		aes.load8xU32(q, plaintext.slice(0, 16), plaintext.slice(16, 32));
		aes.load8xU32(stk, stks[0][0], stks[1][0]);
		aes.addRoundKey(q, stk);

		for (let i = 1; i <= rounds; i++) {
			aes.subBytes(q);
			aes.shiftRows(q);
			aes.mixColumns(q);

			aes.load8xU32(stk, stks[0][i], stks[1][i]);
			aes.addRoundKey(q, stk);
		}

		let tag0 = tag.readUInt32LE(0);
		let tag1 = tag.readUInt32LE(4);
		let tag2 = tag.readUInt32LE(8);
		let tag3 = tag.readUInt32LE(12);

		aes.ortho(q);
		tag0 = uint32.xor(tag0, q[0], q[1]);
		tag1 = uint32.xor(tag1, q[2], q[3]);
		tag2 = uint32.xor(tag2, q[4], q[5]);
		tag3 = uint32.xor(tag3, q[6], q[7]);

		tag.writeUInt32LE(tag0, 0);
		tag.writeUInt32LE(tag1, 4);
		tag.writeUInt32LE(tag2, 8);
		tag.writeUInt32LE(tag3, 12);
	}
}

class implUnsafeVartime {
	static bcEncrypt(ciphertext, derivedKs, tweak, plaintext) {
		let stks = newStks();
		deriveSubTweakKeys(stks, derivedKs, tweak);

		let s0 = plaintext.readUInt32BE(0);
		let s1 = plaintext.readUInt32BE(4);
		let s2 = plaintext.readUInt32BE(8);
		let s3 = plaintext.readUInt32BE(12);

		s0 = uint32.xor(s0, stks[0].readUInt32BE(0));
		s1 = uint32.xor(s1, stks[0].readUInt32BE(4));
		s2 = uint32.xor(s2, stks[0].readUInt32BE(8));
		s3 = uint32.xor(s3, stks[0].readUInt32BE(12));

		for (let i = 1; i <= rounds; i++) {
			[s0, s1, s2, s3] = unsafe.aesencVartime(s0, s1, s2, s3, stks[i]);
		}

		ciphertext.writeUInt32BE(s0, 0);
		ciphertext.writeUInt32BE(s1, 4);
		ciphertext.writeUInt32BE(s2, 8);
		ciphertext.writeUInt32BE(s3, 12);
	}

	static bcKeystreamx2(ciphertext, derivedKs, tweaks, nonce) {
		this.bcEncrypt(ciphertext.slice(0, 16), derivedKs, tweaks[0], nonce);
		this.bcEncrypt(ciphertext.slice(16, 32), derivedKs, tweaks[1], nonce);
	}

	static bcTagx1(tag, derivedKs, tweak, plaintext) {
		let tmp = Buffer.alloc(blockSize);
		this.bcEncrypt(tmp, derivedKs, tweak, plaintext);
		xorBytes(tag, tag, tmp, blockSize);
	}

	static bcTagx2(tag, derivedKs, tweaks, plaintext) {
		let tmp = Buffer.alloc(2*blockSize);
		this.bcEncrypt(tmp.slice(0, 16), derivedKs, tweaks[0], plaintext.slice(0, 16));
		this.bcEncrypt(tmp.slice(16, 32), derivedKs, tweaks[1], plaintext.slice(16, 32));
		xorBytes(tag, tag, tmp.slice(0, 16), blockSize);
		xorBytes(tag, tag, tmp.slice(16, 32), blockSize);
	}
}

//
// Put it all together
//

function encodeTagTweak(out, prefix, blockNr) {
	out.fill(0, 0, 12);
	out.writeUInt32BE(blockNr, 12);
	out[0] = prefix << prefixShift;
}

function encodeEncTweak(out, tag, blockNr) {
	var tmp = Buffer.alloc(4);
	tmp.writeUInt32BE(blockNr);

	tag.copy(out);
	out[0] |= 0x80;

	xorBytes(out.slice(12, 16), out.slice(12, 16), tmp, 4);
}

function newTweaks() {
	let tweaks = [];
	for (let i = 0; i < 2; i++) {
		tweaks.push(Buffer.alloc(tweakSize));
	}
	return tweaks;
}

function e(impl, derivedKs, nonce, dst, ad, msg) {
	let tweaks = newTweaks();
	let i = 0, j = 0;

	// Associated data.
	let adLen = ad.byteLength;
	let auth = Buffer.alloc(TagSize);
	for (i = 0; adLen >= 2*blockSize; i += 2) {
		encodeTagTweak(tweaks[0], prefixADBlock, i);
		encodeTagTweak(tweaks[1], prefixADBlock, i+1);
		impl.bcTagx2(auth, derivedKs, tweaks, ad.slice(i*blockSize, (i+2)*blockSize));

		adLen -= 2*blockSize;
	}
	for (; adLen >= blockSize; i++) {
		encodeTagTweak(tweaks[0], prefixADBlock, i)
		impl.bcTagx1(auth, derivedKs, tweaks[0], ad.slice(i*blockSize, (i+1)*blockSize));

		adLen -= blockSize;
	}
	if (adLen > 0) {
		encodeTagTweak(tweaks[0], prefixADFinal, i);

		let aStar = Buffer.alloc(blockSize);
		ad.copy(aStar, 0, ad.byteLength-adLen);
		aStar[adLen] = 0x80;

		impl.bcTagx1(auth, derivedKs, tweaks[0], aStar);
	}

	// Message authentication and tag generation.
	let msgLen = msg.byteLength;
	for (j = 0; msgLen >= 2*blockSize; j += 2) {
		encodeTagTweak(tweaks[0], prefixMsgBlock, j);
		encodeTagTweak(tweaks[1], prefixMsgBlock, j+1);
		impl.bcTagx2(auth, derivedKs, tweaks, msg.slice(j*blockSize, (j+2)*blockSize));

		msgLen -= 2*blockSize;
	}
	for (; msgLen >= blockSize; j++) {
		encodeTagTweak(tweaks[0], prefixMsgBlock, j);
		impl.bcTagx1(auth, derivedKs, tweaks[0], msg.slice(j*blockSize, (j+1)*blockSize));

		msgLen -= blockSize;
	}
	if (msgLen > 0) {
		encodeTagTweak(tweaks[0], prefixMsgFinal, j);

		let mStar = Buffer.alloc(blockSize);
		msg.copy(mStar, 0, msg.byteLength-msgLen);
		mStar[msgLen] = 0x80;

		impl.bcTagx1(auth, derivedKs, tweaks[0], mStar);
	}

	// Generate the tag.
	let encNonce = Buffer.alloc(blockSize);
	nonce.copy(encNonce, 1);
	encNonce[0] = prefixTag << prefixShift;
	impl.bcEncrypt(auth, derivedKs, encNonce, auth);

	// Message encryption.
	encNonce[0] = 0;
	msgLen = msg.byteLength;
	let encBlks = Buffer.alloc(2*blockSize);
	for (j = 0; msgLen >= 2*blockSize; j += 2) {
		encodeEncTweak(tweaks[0], auth, j);
		encodeEncTweak(tweaks[1], auth, j+1);

		impl.bcKeystreamx2(encBlks, derivedKs, tweaks, encNonce);
		xorBytes(dst.slice(j*blockSize, (j+2)*blockSize), msg.slice(j*blockSize, (j+2)*blockSize), encBlks, 2*blockSize);

		msgLen -= 2*blockSize;
	}
	for (; msgLen >= blockSize; j++) {
		encodeEncTweak(tweaks[0], auth, j);

		impl.bcEncrypt(encBlks, derivedKs, tweaks[0], encNonce);
		xorBytes(dst.slice(j*blockSize, (j+1)*blockSize), msg.slice(j*blockSize, (j+1)*blockSize), encBlks, blockSize);

		msgLen -= blockSize;
	}
	if (msgLen > 0) {
		encodeEncTweak(tweaks[0], auth, j);

		impl.bcEncrypt(encBlks, derivedKs, tweaks[0], encNonce);
		xorBytes(dst.slice(j*blockSize, msg.byteLength), msg.slice(j*blockSize), encBlks, msgLen);
	}

	// Write the tag to the tail.
	auth.copy(dst, msg.byteLength);
}

function d(impl, derivedKs, nonce, dst, ad, ct) {
	let ctLen = ct.byteLength - TagSize;
	const ciphertext = ct.slice(0, ctLen);
	const tag = ct.slice(ctLen);

	// Message decryption.
	let j = 0;
	let decTweaks = newTweaks();
	let decNonce = Buffer.alloc(blockSize);
	nonce.copy(decNonce, 1);
	let decBlks = Buffer.alloc(2*blockSize);
	for (j = 0; ctLen >= 2*blockSize; j+=2) {
		encodeEncTweak(decTweaks[0], tag, j);
		encodeEncTweak(decTweaks[1], tag, j+1);

		impl.bcKeystreamx2(decBlks, derivedKs, decTweaks, decNonce);
		xorBytes(dst.slice(j*blockSize, (j+2)*blockSize), ciphertext.slice(j*blockSize, (j+2)*blockSize), decBlks, 2*blockSize);

		ctLen -= 2*blockSize;
	}
	for (; ctLen >= blockSize; j++) {
		encodeEncTweak(decTweaks[0], tag, j);

		impl.bcEncrypt(decBlks, derivedKs, decTweaks[0], decNonce);
		xorBytes(dst.slice(j*blockSize, (j+1)*blockSize), ciphertext.slice(j*blockSize, (j+1)*blockSize), decBlks, blockSize);

		ctLen -= blockSize;
	}
	if (ctLen > 0) {
		encodeEncTweak(decTweaks[0], tag, j);

		impl.bcEncrypt(decBlks, derivedKs, decTweaks[0], decNonce);
		xorBytes(dst.slice(j*blockSize), ciphertext.slice(j*blockSize), decBlks, ctLen);
	}

	// Associated data.
	let i = 0;
	let adLen = ad.byteLength;
	let tweaks = newTweaks();
	let auth = Buffer.alloc(TagSize);
	for (i = 0; adLen >= 2*blockSize; i += 2) {
		encodeTagTweak(tweaks[0], prefixADBlock, i);
		encodeTagTweak(tweaks[1], prefixADBlock, i+1);
		impl.bcTagx2(auth, derivedKs, tweaks, ad.slice(i*blockSize, (i+2)*blockSize));

		adLen -= 2*blockSize;
	}
	for (; adLen >= blockSize; i++) {
		encodeTagTweak(tweaks[0], prefixADBlock, i)
		impl.bcTagx1(auth, derivedKs, tweaks[0], ad.slice(i*blockSize, (i+1)*blockSize));

		adLen -= blockSize;
	}
	if (adLen > 0) {
		encodeTagTweak(tweaks[0], prefixADFinal, i);

		let aStar = Buffer.alloc(blockSize);
		ad.copy(aStar, 0, ad.byteLength-adLen);
		aStar[adLen] = 0x80;

		impl.bcTagx1(auth, derivedKs, tweaks[0], aStar);
	}

	// Message authentication and tag generation.
	let msgLen = dst.byteLength;
	for (j = 0; msgLen >= 2*blockSize; j += 2) {
		encodeTagTweak(tweaks[0], prefixMsgBlock, j);
		encodeTagTweak(tweaks[1], prefixMsgBlock, j+1);
		impl.bcTagx2(auth, derivedKs, tweaks, dst.slice(j*blockSize, (j+2)*blockSize));

		msgLen -= 2*blockSize;
	}
	for (; msgLen >= blockSize; j++) {
		encodeTagTweak(tweaks[0], prefixMsgBlock, j);
		impl.bcTagx1(auth, derivedKs, tweaks[0], dst.slice(j*blockSize, (j+1)*blockSize));

		msgLen -= blockSize;
	}
	if (msgLen > 0) {
		encodeTagTweak(tweaks[0], prefixMsgFinal, j);

		let mStar = Buffer.alloc(blockSize);
		dst.copy(mStar, 0, dst.byteLength-msgLen);
		mStar[msgLen] = 0x80;

		impl.bcTagx1(auth, derivedKs, tweaks[0], mStar);
	}

	decNonce[0] = prefixTag << prefixShift;
	impl.bcEncrypt(auth, derivedKs, decNonce, auth);

	return timingSafeEqual(auth, tag);
}

// The AEAD implementation.
//
// As much as possible (as long as the key does not change), instances should
// be reused as deriving the K contribution of the Sub-Tweak Key is relatively
// expensive.
class AEAD {
	constructor(key, useUnsafeVartime = false) {
		if (key.byteLength != KeySize) {
			throw ErrKeySize;
		}

		if (useUnsafeVartime) {
			this.impl = implUnsafeVartime;
		} else {
			this.impl = implCt32;
		}
		this.derivedKs = newStks();
		stkDeriveK(key, this.derivedKs);
	}

	encrypt(nonce, plaintext = null, associatedData = null) {
		if (nonce.byteLength != NonceSize) {
			throw ErrNonceSize;
		}

		if (plaintext == null) {
			plaintext = zeroBuffer;
		}
		if (associatedData == null) {
			associatedData = zeroBuffer;
		}

		let dst = Buffer.alloc(plaintext.byteLength + TagSize);
		e(this.impl, this.derivedKs, nonce, dst, associatedData, plaintext);

		return dst;
	}

	decrypt(nonce, ciphertext, associatedData) {
		if (nonce.byteLength != NonceSize) {
			throw ErrNonceSize;
		}
		if (ciphertext.byteLength < TagSize) {
			throw ErrOpen;
		}

		if (associatedData == null) {
			associatedData = zeroBuffer;
		}

		let dst = Buffer.alloc(ciphertext.byteLength - TagSize);
		if (!d(this.impl, this.derivedKs, nonce, dst, associatedData, ciphertext)) {
			dst.fill(0x00);
			throw ErrOpen;
		}

		return dst;
	}
}

const zeroBuffer = Buffer.alloc(0);

const ErrKeySize = 'deoxysii: invalid key size';
const ErrNonceSize = 'deoxysii: invalid nonce size';
const ErrOpen = 'deoxysii: message authentication failure'

module.exports = {
	KeySize: KeySize,
	NonceSize: NonceSize,
	TagSize: TagSize,

	ErrNonceSize: ErrNonceSize,
	ErrKeySize: ErrKeySize,
	ErrOpen: ErrOpen,

	AEAD: AEAD,
}