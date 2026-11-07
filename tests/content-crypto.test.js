const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadCipher() {
    const context = { window: {}, crypto: webcrypto, TextEncoder, TextDecoder };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/src/main/assets/web/aes-gcm.js'), 'utf8'), context);
    return context.window.WenBoxCipher;
}

test('bundled LAN AES-GCM fallback interoperates with WebCrypto', async () => {
    const cipher = loadCipher();
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const nonce = Uint8Array.from({ length: 12 }, (_, i) => 200 - i);
    const aad = new TextEncoder().encode('wenbox-message:v1:room-test');
    const plaintext = new TextEncoder().encode('非安全局域网下的消息正文');

    const sealed = cipher.gcm(key, nonce, aad).encrypt(plaintext);
    const cryptoKey = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const opened = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        cryptoKey,
        sealed
    );
    assert.equal(new TextDecoder().decode(opened), '非安全局域网下的消息正文');
    assert.equal(new TextDecoder().decode(cipher.gcm(key, nonce, aad).decrypt(sealed)), '非安全局域网下的消息正文');
});
