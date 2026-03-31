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

let fatalError: Error | null = null;

try {
    await runActor({
        setAbortHandler(handler) {
            persistAbortState = handler;
        },
    });
} catch (error) {
    fatalError = error instanceof Error ? error : new Error('Deep investigation run failed with an unknown error.');
    log.exception(fatalError, 'Deep investigation run failed with an unhandled exception.');
} finally {
    if (fatalError) {
        await Actor.fail(fatalError.message);
    } else {
        await Actor.exit();
    }
}
