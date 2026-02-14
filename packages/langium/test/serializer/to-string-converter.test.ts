/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import { DefaultToStringConverterService } from '../../src/serializer/to-string-converter.js';

describe('DefaultToStringConverterService', () => {
    test('provides default converters', () => {
        const service = new DefaultToStringConverterService();

        expect(service.getConverter('ID')('myId')).toBe('myId');
        expect(service.getConverter('INT')(42)).toBe('42');
        expect(service.getConverter('STRING')('a"b')).toBe('"a\\"b"');
    });

    test('allows registering custom converters', () => {
        const service = new DefaultToStringConverterService();

        service.register('HEX', (value: unknown) => `0x${Number(value).toString(16)}`);
        expect(service.getConverter('HEX')(255)).toBe('0xff');
    });
});
