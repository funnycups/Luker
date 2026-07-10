// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { encodeCardBoundOptionValue, decodeCardBoundOptionValue } from '/scripts/character/preset-ref-codec.js';

test('round-trip normal case', () => {
    const enc = encodeCardBoundOptionValue('Aqua.png', 'SFW Storyteller');
    const dec = decodeCardBoundOptionValue(enc);
    expect(dec).toEqual({ avatar: 'Aqua.png', name: 'SFW Storyteller' });
});

test('round-trip with :: in name', () => {
    const enc = encodeCardBoundOptionValue('Aqua.png', 'Foo::Bar');
    const dec = decodeCardBoundOptionValue(enc);
    expect(dec).toEqual({ avatar: 'Aqua.png', name: 'Foo::Bar' });
});

test('round-trip with unicode', () => {
    const enc = encodeCardBoundOptionValue('三月七.png', '战斗预设');
    const dec = decodeCardBoundOptionValue(enc);
    expect(dec).toEqual({ avatar: '三月七.png', name: '战斗预设' });
});

test('decode returns null for non-card values', () => {
    expect(decodeCardBoundOptionValue('GlobalA')).toBeNull();
    expect(decodeCardBoundOptionValue('')).toBeNull();
    expect(decodeCardBoundOptionValue(null)).toBeNull();
    expect(decodeCardBoundOptionValue('__luker_card__::onlyone')).toBeNull();
});
