import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { runActor } from './actor-runner.js';

let persistAbortState: (() => Promise<void>) | null = null;

Actor.on('aborting', async () => {
    if (persistAbortState) {
        try {
            await persistAbortState();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown abort checkpoint persistence error.';
            log.warning(`Failed to persist abort checkpoint: ${message}`);
        }
    }

    await setTimeout(1_000);
    await Actor.exit();
});

await Actor.init();

try {
    await runActor({
        setAbortHandler(handler) {
            persistAbortState = handler;
        },
    });
} finally {
    await Actor.exit();
}
