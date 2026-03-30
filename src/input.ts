import type { ActorInput } from './types.js';

export function normalizeUsername(rawUsername: string): string {
    return rawUsername.trim().replace(/^@+/, '').toLowerCase();
}

export function parseInput(input: unknown): ActorInput {
    if (!input || typeof input !== 'object') {
        throw new Error('Input must be a JSON object.');
    }

    const username = Reflect.get(input, 'username');
    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new Error('Input.username must be a non-empty string.');
    }

    const normalizedUsername = normalizeUsername(username);
    if (!/^[a-z0-9._]+$/i.test(normalizedUsername)) {
        throw new Error('Input.username must be a valid Instagram username.');
    }

    const runMode = Reflect.get(input, 'runMode');
    const normalizedRunMode = runMode === 'freshness' ? 'freshness' : 'backfill';

    const maxDiscoveryCycles = Reflect.get(input, 'maxDiscoveryCycles');
    let normalizedMaxDiscoveryCycles: number;
    if (typeof maxDiscoveryCycles === 'number' && Number.isInteger(maxDiscoveryCycles) && maxDiscoveryCycles > 0) {
        normalizedMaxDiscoveryCycles = maxDiscoveryCycles;
    } else if (normalizedRunMode === 'freshness') {
        normalizedMaxDiscoveryCycles = 2;
    } else {
        normalizedMaxDiscoveryCycles = 5;
    }

    return {
        username: normalizedUsername,
        runMode: normalizedRunMode,
        maxDiscoveryCycles: normalizedMaxDiscoveryCycles,
    };
}
