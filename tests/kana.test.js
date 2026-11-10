const test = require('node:test');
const assert = require('node:assert/strict');
const Kana = require('../lib/kana.js');

test('kana: hiragana dasar', () => {
    assert.equal(Kana.romanize('あいうえお'), 'aiueo');
    assert.equal(Kana.romanize('こんにちは'), 'konnichiha');
    assert.equal(Kana.romanize('ありがとう'), 'arigatou');
});

test('kana: katakana dikonversi seperti hiragana', () => {
    assert.equal(Kana.romanize('カタカナ'), 'katakana');
    assert.equal(Kana.romanize('コーヒー'), 'koohii');
    assert.equal(Kana.romanize('ファイル'), 'fairu');
});

test('kana: sokuon (っ) menggandakan konsonan berikutnya', () => {
    assert.equal(Kana.romanize('がっこう'), 'gakkou');
    assert.equal(Kana.romanize('ちょっと'), 'chotto');
});

test('kana: youon dan kombinasi dua karakter', () => {
    assert.equal(Kana.romanize('きょう'), 'kyou');
    assert.equal(Kana.romanize('しゃしん'), 'shashin');
    assert.equal(Kana.romanize('ぱーてぃー'), 'paatii');
});

test('kana: teks non-kana dibiarkan apa adanya', () => {
    assert.equal(Kana.romanize('hello 123!'), 'hello 123!');
    assert.equal(Kana.romanize(''), '');
    assert.equal(Kana.romanize(null), '');
});

test('kana: deteksi kanji dan kana', () => {
    assert.equal(Kana.hasKanji('東京'), true);
    assert.equal(Kana.hasKanji('こんにちは'), false);
    assert.equal(Kana.hasKanji('hello'), false);

    assert.equal(Kana.hasKana('こんにちは'), true);
    assert.equal(Kana.hasKana('カタカナ'), true);
    assert.equal(Kana.hasKana('hello'), false);
});
