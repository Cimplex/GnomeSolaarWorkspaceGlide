import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MODE, PROBE_MARKER, cacheFromProbe, mergeButtons, modeLabel, parseCommandLine, parseProbeOutput, parseShebang,
} from '../extension/solaarDiscovery.js';

test('command lines of a packaged, pip-installed and source Solaar', () => {
    assert.deepEqual(parseCommandLine(['/usr/bin/python3', '-sP', '/usr/bin/solaar', '--window=hide']),
        {interpreter: '/usr/bin/python3', options: ['-sP'], script: '/usr/bin/solaar'});
    assert.deepEqual(parseCommandLine(['/usr/bin/python3', '/home/u/.local/bin/solaar']),
        {interpreter: '/usr/bin/python3', options: [], script: '/home/u/.local/bin/solaar'});
    assert.deepEqual(parseCommandLine(['python3.14', '-X', 'dev', 'bin/solaar', '-w', 'hide']),
        {interpreter: 'python3.14', options: ['-X', 'dev'], script: 'bin/solaar'});
    assert.deepEqual(parseCommandLine(['/opt/solaar/solaar']), {interpreter: null, options: [], script: '/opt/solaar/solaar'});
    assert.equal(parseCommandLine(['/usr/bin/python3', '-m', 'solaar']), null);
    assert.equal(parseCommandLine(['/usr/bin/bash']), null);
    assert.equal(parseCommandLine([]), null);
});

test('shebangs', () => {
    assert.deepEqual(parseShebang('#!/usr/bin/python3 -sP'), {interpreter: '/usr/bin/python3', options: ['-sP']});
    assert.deepEqual(parseShebang('#!/usr/bin/env python3'), {interpreter: 'python3', options: []});
    assert.deepEqual(parseShebang('#!/usr/bin/env -S python3 -s'), {interpreter: 'python3', options: ['-s']});
    assert.equal(parseShebang('#!/bin/sh'), null);
    assert.equal(parseShebang('import sys'), null);
});

test('probe output is found after Solaar warnings on stdout', () => {
    const stdout = `rules cannot access modifier keys in Wayland\n${PROBE_MARKER}\n{"patched": true, "live": []}\n`;
    assert.deepEqual(parseProbeOutput(stdout), {patched: true, live: []});
    assert.throws(() => parseProbeOutput('Traceback ...'), /did not answer/);
});

test('mode labels', () => {
    assert.equal(modeLabel(MODE.MOVEMENT_STREAM), 'Movement Stream');
    assert.equal(modeLabel(MODE.MOUSE_GESTURES), 'Mouse Gestures');
    assert.equal(modeLabel(9), 'Mode 9');
    assert.equal(modeLabel(null), 'Unknown');
});

const SAVED = [{
    unitId: '12D5FD67', name: 'MX Master 4', buttons: [
        {control: 82, name: 'Middle Button', mode: 0},
        {control: 195, name: 'Mouse Gesture Button', mode: 0},
        {control: 416, name: 'Haptic', mode: 5},
    ],
}];

test('a connected device lists exactly the buttons Solaar says have raw XY, with saved modes', () => {
    const probe = {
        saved: SAVED,
        live: [{
            unitId: '12D5FD67', serial: '12D5FD67', name: 'MX Master 4', online: true, buttons: [
                {control: 195, name: 'Mouse Gesture Button', streamable: true, streamChoice: 4},
                {control: 416, name: 'Haptic', streamable: true, streamChoice: 5},
            ],
        }],
    };
    const [mouse] = mergeButtons({probe});
    assert.equal(mouse.online, true);
    assert.equal(mouse.serial, '12D5FD67');
    assert.deepEqual(mouse.buttons.map(b => [b.control, b.streamable, b.streamChoice, b.mode]),
        [[195, true, 4, 0], [416, true, 5, 5]]);
});

test('an unpatched Solaar reports raw-XY buttons as not streamable yet', () => {
    const probe = {
        live: [{unitId: 'A', name: 'Mouse', online: true, buttons: [{control: 416, name: 'Haptic', streamable: false}]}],
    };
    const [mouse] = mergeButtons({probe});
    assert.equal(mouse.buttons[0].streamable, false);
    assert.equal(mouse.buttons[0].streamChoice, null);
});

test('a disconnected device shows its raw-XY buttons from the saved configuration and cache', () => {
    const [fromSaved] = mergeButtons({probe: {saved: SAVED, live: []}});
    assert.equal(fromSaved.online, false);
    assert.deepEqual(fromSaved.buttons.map(b => [b.control, b.streamable, b.mode]), [[416, true, 5]],
        'Regular buttons are left out because the saved file cannot say whether they have raw XY');

    const cache = [{unitId: '12D5FD67', name: 'MX Master 4', buttons: [{control: 195, name: 'Mouse Gesture Button'}]}];
    const [fromCache] = mergeButtons({probe: {saved: SAVED, live: []}, cache});
    assert.deepEqual(fromCache.buttons.map(b => [b.control, b.streamable, b.mode]), [[195, null, 0], [416, true, 5]]);
});

test('buttons seen streaming are listed even for devices Solaar did not report', () => {
    const devices = mergeButtons({probe: {}, seen: ['BEEF:195', 'bad', 'BEEF:x']});
    assert.equal(devices.length, 1);
    assert.equal(devices[0].unitId, 'BEEF');
    assert.deepEqual(devices[0].buttons.map(b => [b.control, b.name, b.streamable, b.seen]),
        [[195, 'Control 0x00C3', true, true]]);
});

test('devices without any raw-XY button are not listed and the rest sort by name', () => {
    const probe = {
        live: [
            {unitId: 'K', name: 'Keyboard', online: true, buttons: []},
            {unitId: 'Z', name: 'Zed Mouse', online: true, buttons: [{control: 1, name: 'One', streamable: true}]},
            {unitId: 'A', name: 'Alpha Mouse', online: true, buttons: [{control: 1, name: 'One', streamable: true}]},
        ],
    };
    assert.deepEqual(mergeButtons({probe}).map(d => d.name), ['Alpha Mouse', 'Zed Mouse']);
});

test('the cache remembers connected devices and keeps disconnected ones', () => {
    const previous = [{unitId: 'OLD', name: 'Old Mouse', buttons: [{control: 195, name: 'Gesture'}]}];
    const probe = {live: [
        {unitId: 'NEW', name: 'New Mouse', online: true, buttons: [{control: 416, name: 'Haptic', streamable: true, streamChoice: 5}]},
        {unitId: 'OFF', name: 'Off Mouse', online: false, buttons: []},
    ]};
    assert.deepEqual(cacheFromProbe(probe, previous), [
        {unitId: 'OLD', name: 'Old Mouse', buttons: [{control: 195, name: 'Gesture'}]},
        {unitId: 'NEW', serial: null, name: 'New Mouse', buttons: [{control: 416, name: 'Haptic'}]},
    ]);
});
