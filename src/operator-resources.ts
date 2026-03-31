import { Actor, log } from 'apify';
import { type BrowserContext, chromium, type Page } from 'playwright';

import { dedupeByKey, extractMentionedUsernames } from './comment-utils.js';
import { openPersistentStore } from './persistent-store.js';
import type { ActorInput, OperatorAccountDiagnostic, OperatorAccountInput, OperatorResourcesSummary } from './types.js';

export const OPERATOR_SESSION_STORE_NAME = 'operator-sessions';
const SESSION_KEY_PREFIX = 'OPERATOR_SESSION__';

interface PersistedOperatorSessionState {
    username: string;
    sessionKey: string;
    savedAt: string;
    storageState: StorageState;
}

interface PreparedOperatorAccount {
    username: string;
    sessionKey: string;
    storageState: StorageState;
    proxyUrl: string;
    sessionSource: 'reused' | 'bootstrapped';
}

export interface PreparedOperatorResources {
    summary: OperatorResourcesSummary;
    readyAccounts: PreparedOperatorAccount[];
    accountDiagnostics: OperatorAccountDiagnostic[];
}

export interface RootGraphExpansionResult {
    bioLinkedUsernames: string[];
    followersUsernames: string[];
    followingUsernames: string[];
    warnings: string[];
}

function buildOperatorSessionKey(account: Pick<OperatorAccountInput, 'username' | 'sessionKey'>): string {
    return `${SESSION_KEY_PREFIX}${account.sessionKey ?? account.username}`;
}

function normalizeProxySessionId(sessionKey: string): string {
    const normalized = sessionKey.replace(/[^\w._~]+/g, '_');
    return normalized.length > 0 ? normalized : 'operator_session';
}

function hasSessionCookie(storageState: StorageState): boolean {
    return storageState.cookies.some((cookie: StorageState['cookies'][number]) => cookie.name === 'sessionid' && cookie.value.length > 0);
}

function toPlaywrightProxy(proxyUrl: string): { server: string; username?: string; password?: string } {
    const parsedUrl = new URL(proxyUrl);
    return {
        server: `${parsedUrl.protocol}//${parsedUrl.host}`,
        username: parsedUrl.username || undefined,
        password: parsedUrl.password || undefined,
    };
}

function parseUsernamesFromEntries(entries: { href: string | null; text: string | null }[], limit: number): string[] {
    const usernames = new Set<string>();

    for (const entry of entries) {
        if (usernames.size >= limit) break;
        const href = entry.href ?? '';
        const hrefMatch = href.match(/^\/([A-Za-z0-9._]+)\/$/);
        if (hrefMatch) {
            usernames.add(hrefMatch[1].toLowerCase());
            continue;
        }

        const text = (entry.text ?? '').trim();
        if (/^[A-Za-z0-9._]+$/.test(text)) {
            usernames.add(text.toLowerCase());
        }
    }

    return [...usernames].slice(0, limit);
}

async function dismissInstagramCookieBanner(page: Page): Promise<void> {
    const buttons = ['Allow all cookies', 'Allow essential and optional cookies', 'Accept'];
    for (const label of buttons) {
        const button = page.getByRole('button', { name: label }).first();
        if (await button.count()) {
            try {
                await button.click({ timeout: 2_000 });
                return;
            } catch {
                // Ignore and try the next label.
            }
        }
    }
}

async function bootstrapOperatorSession(input: {
    account: OperatorAccountInput;
    proxyUrl: string;
}): Promise<StorageState | null> {
    const { account, proxyUrl } = input;
    const browser = await chromium.launch({
        headless: true,
        proxy: toPlaywrightProxy(proxyUrl),
    });

    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('https://www.instagram.com/accounts/login/', {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });
        await page.waitForTimeout(2_000);
        await dismissInstagramCookieBanner(page);
        await page.locator('input[name="username"]').fill(account.username, { timeout: 15_000 });
        await page.locator('input[name="password"]').fill(account.password, { timeout: 15_000 });
        await page.locator('button[type="submit"]').click({ timeout: 15_000 });
        await page.waitForTimeout(8_000);

        const storageState = await context.storageState();
        return hasSessionCookie(storageState) ? storageState : null;
    } finally {
        await browser.close();
    }
}

async function collectRelationshipUsernames(input: {
    storageState: StorageState;
    proxyUrl: string;
    targetUsername: string;
    relationship: 'followers' | 'following';
    limit: number;
}): Promise<string[]> {
    const { storageState, proxyUrl, targetUsername, relationship, limit } = input;
    const browser = await chromium.launch({
        headless: true,
        proxy: toPlaywrightProxy(proxyUrl),
    });

    try {
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        await page.goto(`https://www.instagram.com/${targetUsername}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });
        await page.waitForTimeout(3_000);

        const relationshipLink = page.locator(`a[href="/${targetUsername}/${relationship}/"]`).first();
        if (!await relationshipLink.count()) {
            return [];
        }

        await relationshipLink.click({ timeout: 10_000 });
        await page.waitForSelector('div[role="dialog"]', { timeout: 10_000 });
        const dialog = page.locator('div[role="dialog"]').last();

        const usernames = new Set<string>();
        let unchangedIterations = 0;
        while (usernames.size < limit && unchangedIterations < 4) {
            const beforeCount = usernames.size;
            const rawEntries = await dialog.locator('a').evaluateAll((anchors) => {
                return anchors.map((anchor) => ({
                    href: anchor.getAttribute('href'),
                    text: anchor.textContent,
                }));
            });

            for (const username of parseUsernamesFromEntries(rawEntries, limit)) {
                usernames.add(username);
                if (usernames.size >= limit) break;
            }

            if (usernames.size === beforeCount) {
                unchangedIterations += 1;
            } else {
                unchangedIterations = 0;
            }

            await dialog.evaluate((element) => {
                const scrollable = element.querySelector('div[style*="overflow"]') ?? element;
                scrollable.scrollTop = scrollable.scrollHeight;
            });
            await page.waitForTimeout(800);
        }

        await page.keyboard.press('Escape').catch(() => undefined);
        return [...usernames].slice(0, limit);
    } finally {
        await browser.close();
    }
}

export async function openOperatorSessionStore() {
    return openPersistentStore({
        preferredName: OPERATOR_SESSION_STORE_NAME,
        fallbackNamespace: 'OPERATOR_SESSIONS',
    });
}

export async function prepareOperatorResources(input: {
    actorInput: ActorInput;
}): Promise<PreparedOperatorResources> {
    const { actorInput } = input;
    const warnings: string[] = [];
    const sessionStore = await openOperatorSessionStore();

    if (actorInput.operatorAccounts.length === 0) {
        return {
            summary: {
                readiness: 'not_configured',
                configuredAccounts: 0,
                readyAccounts: 0,
                reusedSessions: 0,
                bootstrappedSessions: 0,
                proxyConfigured: false,
                graphExpansion: {
                    bioLinkedUsernames: 0,
                    followersUsernames: 0,
                    followingUsernames: 0,
                    expandedProfiles: 0,
                    expandedPosts: 0,
                },
                warnings: ['No operator accounts were configured, so session-aware deep discovery is disabled for this run.'],
            },
            readyAccounts: [],
            accountDiagnostics: [],
        };
    }

    if (!actorInput.proxyConfiguration) {
        return {
            summary: {
                readiness: 'proxy_missing',
                configuredAccounts: actorInput.operatorAccounts.length,
                readyAccounts: 0,
                reusedSessions: 0,
                bootstrappedSessions: 0,
                proxyConfigured: false,
                graphExpansion: {
                    bioLinkedUsernames: 0,
                    followersUsernames: 0,
                    followingUsernames: 0,
                    expandedProfiles: 0,
                    expandedPosts: 0,
                },
                warnings: ['Proxy configuration is required before operator accounts can bootstrap or reuse deep-investigation sessions.'],
            },
            readyAccounts: [],
            accountDiagnostics: actorInput.operatorAccounts.map((account) => ({
                username: account.username,
                sessionKey: account.sessionKey ?? account.username,
                hadPersistedSession: false,
                proxyUrlGenerated: false,
                sessionSource: null,
                outcome: 'proxy_configuration_unavailable',
                warning: 'Proxy configuration is missing.',
            })),
        };
    }

    let proxyConfiguration: Awaited<ReturnType<typeof Actor.createProxyConfiguration>> | null = null;
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({
            ...actorInput.proxyConfiguration,
            checkAccess: false,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown proxy configuration error.';
        warnings.push(`Proxy configuration could not be initialized: ${message}`);
        log.warning(`Operator resource bootstrap could not initialize proxy configuration: ${message}`);
    }

    if (!proxyConfiguration) {
        warnings.push('Proxy configuration could not be initialized, so operator-resource bootstrapping was skipped.');
    }

    const readyAccounts: PreparedOperatorAccount[] = [];
    const accountDiagnostics: OperatorAccountDiagnostic[] = [];
    let reusedSessions = 0;
    let bootstrappedSessions = 0;

    for (const account of actorInput.operatorAccounts) {
        const sessionKey = account.sessionKey ?? account.username;
        const proxySessionId = normalizeProxySessionId(sessionKey);
        const persistedState = await sessionStore.getValue<PersistedOperatorSessionState>(buildOperatorSessionKey(account));
        const accountDiagnostic: OperatorAccountDiagnostic = {
            username: account.username,
            sessionKey,
            hadPersistedSession: Boolean(persistedState?.storageState && hasSessionCookie(persistedState.storageState)),
            proxyUrlGenerated: false,
            sessionSource: null,
            outcome: 'proxy_configuration_unavailable',
            warning: null,
        };

        if (!proxyConfiguration) {
            accountDiagnostic.warning = 'Proxy configuration could not be initialized.';
            accountDiagnostics.push(accountDiagnostic);
            continue;
        }

        const proxyUrl = await proxyConfiguration.newUrl(proxySessionId);
        if (!proxyUrl) {
            accountDiagnostic.outcome = 'proxy_unavailable';
            accountDiagnostic.warning = `No proxy URL could be generated for operator account @${account.username}.`;
            warnings.push(accountDiagnostic.warning);
            accountDiagnostics.push(accountDiagnostic);
            log.warning(accountDiagnostic.warning);
            continue;
        }
        accountDiagnostic.proxyUrlGenerated = true;

        if (persistedState?.storageState && hasSessionCookie(persistedState.storageState)) {
            readyAccounts.push({
                username: account.username,
                sessionKey,
                storageState: persistedState.storageState,
                proxyUrl,
                sessionSource: 'reused',
            });
            accountDiagnostic.sessionSource = 'reused';
            accountDiagnostic.outcome = 'reused_session';
            accountDiagnostics.push(accountDiagnostic);
            reusedSessions += 1;
            log.info(`Operator resource @${account.username}: reused persisted Instagram session.`);
            continue;
        }

        try {
            log.info(`Operator resource @${account.username}: attempting Instagram session bootstrap.`);
            const storageState = await bootstrapOperatorSession({
                account,
                proxyUrl,
            });

            if (!storageState) {
                accountDiagnostic.outcome = 'bootstrap_failed';
                accountDiagnostic.warning = `Operator account @${account.username} could not establish a reusable Instagram session.`;
                warnings.push(accountDiagnostic.warning);
                accountDiagnostics.push(accountDiagnostic);
                log.warning(accountDiagnostic.warning);
                continue;
            }

            const persistedSession: PersistedOperatorSessionState = {
                username: account.username,
                sessionKey,
                savedAt: new Date().toISOString(),
                storageState,
            };
            await sessionStore.setValue(buildOperatorSessionKey(account), persistedSession);
            readyAccounts.push({
                username: account.username,
                sessionKey,
                storageState,
                proxyUrl,
                sessionSource: 'bootstrapped',
            });
            accountDiagnostic.sessionSource = 'bootstrapped';
            accountDiagnostic.outcome = 'bootstrapped_session';
            accountDiagnostics.push(accountDiagnostic);
            bootstrappedSessions += 1;
            log.info(`Operator resource @${account.username}: Instagram session bootstrap succeeded.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown operator bootstrap error.';
            accountDiagnostic.outcome = 'bootstrap_failed';
            accountDiagnostic.warning = `Operator account @${account.username} failed to bootstrap an Instagram session: ${message}`;
            warnings.push(accountDiagnostic.warning);
            accountDiagnostics.push(accountDiagnostic);
            log.warning(`Operator bootstrap failed for @${account.username}: ${message}`);
        }
    }

    const readiness: OperatorResourcesSummary['readiness'] = (() => {
        if (readyAccounts.length === 0) return 'not_ready';
        if (warnings.length > 0) return 'partial';
        return 'ready';
    })();

    return {
        summary: {
            readiness,
            configuredAccounts: actorInput.operatorAccounts.length,
            readyAccounts: readyAccounts.length,
            reusedSessions,
            bootstrappedSessions,
            proxyConfigured: true,
            graphExpansion: {
                bioLinkedUsernames: 0,
                followersUsernames: 0,
                followingUsernames: 0,
                expandedProfiles: 0,
                expandedPosts: 0,
            },
            warnings,
        },
        readyAccounts,
        accountDiagnostics,
    };
}

export async function expandRootGraphWithOperatorResources(input: {
    actorInput: ActorInput;
    targetUsername: string;
    biography: string | null;
    preparedResources: PreparedOperatorResources;
}): Promise<RootGraphExpansionResult> {
    const { actorInput, targetUsername, biography, preparedResources } = input;
    const warnings: string[] = [];
    const bioLinkedUsernames = new Set<string>(extractMentionedUsernames(biography));

    const primaryAccount = preparedResources.readyAccounts[0];
    if (!primaryAccount) {
        log.warning(`Root graph expansion skipped for @${targetUsername}: no operator session is ready.`);
        return {
            bioLinkedUsernames: [...bioLinkedUsernames],
            followersUsernames: [],
            followingUsernames: [],
            warnings: [...preparedResources.summary.warnings],
        };
    }

    try {
        log.info(`Root graph expansion for @${targetUsername}: inspecting profile via operator @${primaryAccount.username}.`);
        const browser = await chromium.launch({
            headless: true,
            proxy: toPlaywrightProxy(primaryAccount.proxyUrl),
        });

        try {
            const context = await browser.newContext({
                storageState: primaryAccount.storageState,
            });
            const page = await context.newPage();
            await page.goto(`https://www.instagram.com/${targetUsername}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
            });
            await page.waitForTimeout(3_000);
            const pageText = await page.locator('body').innerText().catch(() => '');
            for (const username of extractMentionedUsernames(pageText)) {
                bioLinkedUsernames.add(username);
            }
        } finally {
            await browser.close();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown profile inspection error.';
        warnings.push(`Could not inspect @${targetUsername} through an operator session for bio-linked pivots: ${message}`);
    }

    let followersUsernames: string[] = [];
    let followingUsernames: string[] = [];

    try {
        followersUsernames = await collectRelationshipUsernames({
            storageState: primaryAccount.storageState,
            proxyUrl: primaryAccount.proxyUrl,
            targetUsername,
            relationship: 'followers',
            limit: actorInput.graphExpansion.maxFollowersToInspect,
        });
        log.info(`Root graph expansion for @${targetUsername}: collected ${followersUsernames.length} follower usernames.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown followers expansion error.';
        warnings.push(`Followers root expansion failed for @${targetUsername}: ${message}`);
    }

    try {
        followingUsernames = await collectRelationshipUsernames({
            storageState: primaryAccount.storageState,
            proxyUrl: primaryAccount.proxyUrl,
            targetUsername,
            relationship: 'following',
            limit: actorInput.graphExpansion.maxFollowingToInspect,
        });
        log.info(`Root graph expansion for @${targetUsername}: collected ${followingUsernames.length} following usernames.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown following expansion error.';
        warnings.push(`Following root expansion failed for @${targetUsername}: ${message}`);
    }

    return {
        bioLinkedUsernames: [...bioLinkedUsernames],
        followersUsernames,
        followingUsernames,
        warnings,
    };
}

export function summarizeGraphExpansion(input: {
    previousSummary: OperatorResourcesSummary;
    expansion: RootGraphExpansionResult;
    expandedProfiles: number;
    expandedPosts: number;
}): OperatorResourcesSummary {
    const { previousSummary, expansion, expandedProfiles, expandedPosts } = input;

    return {
        ...previousSummary,
        graphExpansion: {
            bioLinkedUsernames: expansion.bioLinkedUsernames.length,
            followersUsernames: expansion.followersUsernames.length,
            followingUsernames: expansion.followingUsernames.length,
            expandedProfiles,
            expandedPosts,
        },
        warnings: dedupeByKey([...previousSummary.warnings, ...expansion.warnings], (warning) => warning),
    };
}

export function parseUsernamesFromDialogAnchors(entries: { href: string | null; text: string | null }[], limit: number): string[] {
    return parseUsernamesFromEntries(entries, limit);
}

export function sessionStateContainsInstagramLogin(storageState: StorageState): boolean {
    return hasSessionCookie(storageState);
}
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
