import { initAccessibility } from './a11y.js';

/**
 * CRSF token for requests.
 */
let csrfToken = '';
let discreetLogin = false;
let oauthAvailable = false;

/**
 * Gets a CSRF token from the server.
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

/**
 * Gets a list of users from the server.
 * @returns {Promise<object>} List of users
 */
async function getUserList() {
    const response = await fetch('/api/users/list', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    if (response.status === 204) {
        discreetLogin = true;
        return [];
    }

    return response.json();
}

/**
 * Gets enabled OAuth providers from the server.
 * @returns {Promise<{providers: {github?: boolean, discord?: boolean}}|null>}
 */
async function getOAuthProviders() {
    try {
        const response = await fetch('/api/users/oauth/providers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
        });

        if (!response.ok) {
            return null;
        }

        return response.json();
    } catch {
        return null;
    }
}

/**
 * Gets account registration availability from the server.
 * @returns {Promise<{enabled: boolean}|null>}
 */
async function getRegistrationInfo() {
    try {
        const response = await fetch('/api/users/registration/info', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
        });

        if (!response.ok) {
            return null;
        }

        return response.json();
    } catch {
        return null;
    }
}

/**
 * Submits a registration request to the server.
 * @param {{handle: string, name: string, password: string}} payload
 * @returns {Promise<void>}
 */
async function submitRegistration(payload) {
    try {
        const response = await fetch('/api/users/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return displayError(errorData.error || 'Registration failed.');
        }

        const data = await response.json();
        if (data.handle) {
            redirectToHome();
        }
    } catch (error) {
        console.error('Error registering:', error);
        displayError(String(error));
    }
}

/**
 * Requests a recovery code for the user.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
async function sendRecoveryPart1(handle) {
    const response = await fetch('/api/users/recover-step1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ handle }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    showRecoveryBlock();
}

/**
 * Sets a new password for the user using the recovery code.
 * @param {string} handle User handle
 * @param {string} code Recovery code
 * @param {string} newPassword New password
 * @returns {Promise<void>}
 */
async function sendRecoveryPart2(handle, code, newPassword) {
    const recoveryData = {
        handle,
        code,
        newPassword,
    };

    const response = await fetch('/api/users/recover-step2', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(recoveryData),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    await performLogin(handle, newPassword);
}

/**
 * Attempts to log in the user.
 * @param {string} handle User's handle
 * @param {string} password User's password
 * @returns {Promise<void>}
 */
async function performLogin(handle, password) {
    const userInfo = {
        handle,
        password,
    };

    try {
        const response = await fetch('/api/users/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(userInfo),
        });

        if (!response.ok) {
            const errorData = await response.json();
            return displayError(errorData.error || 'An error occurred');
        }

        const data = await response.json();

        if (data.handle) {
            redirectToHome();
        }
    } catch (error) {
        console.error('Error logging in:', error);
        displayError(String(error));
    }
}

/**
 * Handles the user selection event.
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function onUserSelected(user) {
    // OAuth-only account (created by the GitHub/Discord flow, no local
    // password): the password path is closed for it server-side, so send
    // the user straight to the provider. Prefer the bound provider's
    // start URL; fall back to the login page (which shows the provider
    // buttons) if the account is bound to a provider that is no longer
    // enabled.
    if (!user.password && Array.isArray(user.oauthProviders) && user.oauthProviders.length > 0) {
        const provider = user.oauthProviders.find(p => p === 'github' || p === 'discord');
        if (provider && $(`#oauth${provider.charAt(0).toUpperCase() + provider.slice(1)}Button`).attr('href')) {
            return window.location.assign(`/api/users/oauth/start/${provider}`);
        }
        return displayError('This account signs in with GitHub or Discord. Use the buttons below.');
    }

    if (!user.password) {
        return performLogin(user.handle, '');
    }

    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    $('#loginButton').off('click').on('click', async () => {
        const password = String($('#userPassword').val());
        await performLogin(user.handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        await sendRecoveryPart1(user.handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(user.handle, code, newPassword);
    });

    displayError('');
}

/**
 * Displays an error message to the user.
 * @param {string} message Error message
 */
function displayError(message) {
    $('#errorMessage').text(message);
}

/**
 * Redirects the user to the home page.
 */
function redirectToHome() {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('noauto');
    currentUrl.searchParams.delete('error');
    currentUrl.pathname = '/';
    window.location.href = currentUrl.toString();
}

/**
 * Hides the password entry block and shows the password recovery block.
 */
function showRecoveryBlock() {
    $('#passwordEntryBlock').hide();
    $('#passwordRecoveryBlock').show();
    displayError('');
}

/**
 * Hides the password recovery block and shows the password entry block.
 */
function onCancelRecoveryClick() {
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    displayError('');
}

/**
 * Configures OAuth buttons from provider payload.
 * @param {{providers?: {github?: boolean, discord?: boolean}}|null} oauthPayload
 */
function configureOAuthButtons(oauthPayload) {
    const providers = oauthPayload?.providers || {};

    const githubEnabled = Boolean(providers.github);
    const discordEnabled = Boolean(providers.discord);

    $('#oauthGithubButton').attr('href', '/api/users/oauth/start/github').toggle(githubEnabled);
    $('#oauthDiscordButton').attr('href', '/api/users/oauth/start/discord').toggle(discordEnabled);

    oauthAvailable = githubEnabled || discordEnabled;
    $('#oauthLoginBlock').toggle(oauthAvailable);
}

function showRegisterBlock() {
    $('#userList').hide();
    $('#handleEntryBlock').hide();
    $('#passwordEntryBlock').hide();
    $('#oauthLoginBlock').hide();
    $('#passwordRecoveryBlock').hide();
    $('#registerEntryBlock').hide();
    $('#normalLoginPrompt').hide();
    $('#discreetLoginPrompt').hide();
    $('#registerBlock').show();
    $('#registerName').val('');
    $('#registerHandle').val('');
    $('#registerPassword').val('');
    $('#registerConfirm').val('');
    displayError('');
    $('#registerName').trigger('focus');
}

function hideRegisterBlock() {
    $('#registerBlock').hide();
    if (discreetLogin) {
        $('#handleEntryBlock').show();
        $('#passwordEntryBlock').show();
        $('#discreetLoginPrompt').show();
    } else {
        $('#userList').show();
        $('#normalLoginPrompt').show();
    }
    $('#oauthLoginBlock').toggle(oauthAvailable);
    $('#registerEntryBlock').show();
    displayError('');
}

async function onSubmitRegistrationClick() {
    const name = String($('#registerName').val() || '').trim();
    const handle = String($('#registerHandle').val() || '').trim();
    const password = String($('#registerPassword').val() || '');
    const confirm = String($('#registerConfirm').val() || '');

    if (!name || !handle || !password) {
        return displayError('Display name, handle, and password are required.');
    }

    if (password !== confirm) {
        return displayError('Passwords do not match.');
    }

    await submitRegistration({ handle, name, password });
}

/**
 * Configures the registration entry button + form, if enabled.
 * @param {{enabled?: boolean}|null} registrationPayload
 */
function configureRegistration(registrationPayload) {
    const enabled = Boolean(registrationPayload?.enabled);
    $('#registerEntryBlock').toggle(enabled);

    if (!enabled) {
        return;
    }

    $('#openRegisterLink').off('click').on('click', showRegisterBlock);
    $('#submitRegister').off('click').on('click', onSubmitRegistrationClick);
    $('#cancelRegister').off('click').on('click', hideRegisterBlock);
}

/**
 * Configures the login page for normal login.
 * @param {import('../../src/users').UserViewModel[]} userList List of users
 */
function configureNormalLogin(userList) {
    $('#handleEntryBlock').hide();
    $('#normalLoginPrompt').show();
    $('#discreetLoginPrompt').hide();

    for (const user of userList) {
        const userBlock = $('<div></div>').addClass('userSelect');
        const avatarBlock = $('<div></div>').addClass('avatar');
        avatarBlock.append($('<img>').attr('src', user.avatar));
        userBlock.append(avatarBlock);
        userBlock.append($('<span></span>').addClass('userName').text(user.name));
        userBlock.append($('<small></small>').addClass('userHandle').text(user.handle));
        userBlock.on('click', () => onUserSelected(user));
        $('#userList').append(userBlock);
    }
}

/**
 * Configures the login page for discreet login.
 */
function configureDiscreetLogin() {
    $('#handleEntryBlock').show();
    $('#normalLoginPrompt').hide();
    $('#discreetLoginPrompt').show();
    $('#userList').hide();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    $('#loginButton').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const password = String($('#userPassword').val());
        await performLogin(handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        await sendRecoveryPart1(handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(handle, code, newPassword);
    });
}

function handleOAuthErrorParam() {
    const params = new URLSearchParams(window.location.search);
    const error = String(params.get('error') || '');
    if (!error) {
        return;
    }

    const messages = {
        unsupported_provider: 'Unsupported OAuth provider.',
        provider_not_configured: 'OAuth provider is not configured by admin.',
        oauth_start_failed: 'Failed to start OAuth login.',
        oauth_invalid_callback: 'OAuth callback is invalid.',
        oauth_state_mismatch: 'OAuth state verification failed.',
        oauth_token_failed: 'Failed to obtain OAuth access token.',
        oauth_token_empty: 'OAuth provider returned an empty token.',
        oauth_profile_failed: 'Failed to fetch OAuth profile.',
        oauth_user_not_linked: 'No local account is linked to this OAuth identity.',
        oauth_user_disabled: 'This account is currently disabled.',
        discord_guild_check_failed: 'Discord account did not pass server membership checks.',
        oauth_callback_failed: 'OAuth login failed. Please try again.',
    };

    displayError(messages[error] || 'OAuth login failed.');
}

(async function () {
    initAccessibility();

    csrfToken = await getCsrfToken();
    const [userList, oauthPayload, registrationPayload] = await Promise.all([
        getUserList(),
        getOAuthProviders(),
        getRegistrationInfo(),
    ]);

    if (discreetLogin) {
        configureDiscreetLogin();
    } else {
        configureNormalLogin(userList);
    }

    configureOAuthButtons(oauthPayload);
    configureRegistration(registrationPayload);
    handleOAuthErrorParam();

    document.getElementById('shadow_popup').style.opacity = '';
    $('#cancelRecovery').on('click', onCancelRecoveryClick);
    $(document).on('keydown', (evt) => {
        if (evt.key === 'Enter' && document.activeElement.tagName === 'INPUT') {
            if ($('#registerBlock').is(':visible')) {
                $('#submitRegister').trigger('click');
            } else if ($('#passwordRecoveryBlock').is(':visible')) {
                $('#sendRecovery').trigger('click');
            } else {
                $('#loginButton').trigger('click');
            }
        }
    });
})();
