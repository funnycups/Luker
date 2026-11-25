import { eventSource, event_types, getRequestHeaders } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { t, translate } from '../../i18n.js';
import { oai_settings, proxies } from '../../openai.js';
import { isValidUrl } from '../../utils.js';
import {
    listGoogleNativeTtsConnectionProfiles,
    resolveGoogleNativeTtsConnection,
} from './google-native-connection.js';
import { getPreviewString, saveTtsProviderSettings } from './index.js';

const CONNECTION_PROFILE_EVENTS = [
    event_types.CONNECTION_PROFILE_CREATED,
    event_types.CONNECTION_PROFILE_UPDATED,
    event_types.CONNECTION_PROFILE_DELETED,
];


export class GoogleNativeTtsProvider {
    settings;
    voices = [];
    separator = ' . ';
    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        model: 'gemini-3.1-flash-tts-preview',
        apiType: 'makersuite',
        connectionProfile: '',
    };

    constructor() {
        this.onConnectionProfilesChanged = () => {
            this.renderConnectionProfileSelect();
            this.renderConnStatus();
        };
    }

    dispose() {
        CONNECTION_PROFILE_EVENTS.forEach(event => {
            eventSource.removeListener(event, this.onConnectionProfilesChanged);
        });
    }

    get settingsHtml() {
        return `
        <small>Hint: Save an API key in the Google AI Studio/Vertex AI connection settings</small>
        <div id="google-native-tts-settings">
            <div>
                <label for="google-tts-api-type">API Type:</label>
                <select id="google-tts-api-type">
                    <option value="makersuite">Google AI Studio (MakerSuite)</option>
                    <option value="vertexai" disabled>Google Vertex AI (unsupported)</option>
                </select>
            </div>
            <div>
                <label for="google-tts-connection-profile">${translate('Connection profile:')}</label>
                <select id="google-tts-connection-profile"></select>
                <small id="google-tts-conn-status" class="google-tts-conn-status"></small>
            </div>
            <div>
                <label for="google-tts-model">Model:</label>
                <select id="google-tts-model">
                    <option value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash Preview TTS</option>
                    <option value="gemini-2.5-pro-preview-tts">Gemini 2.5 Pro Preview TTS</option>
                    <option value="gemini-3.1-flash-tts-preview">Gemini 3.1 Flash TTS Preview</option>
                </select>
            </div>
        </div>`;
    }

    getConnectionProfiles() {
        const profiles = getContext()?.connectionProfiles?.list?.();
        return Array.isArray(profiles) ? profiles : [];
    }

    renderConnectionProfileSelect() {
        const select = $('#google-tts-connection-profile');
        if (!select.length) {
            return;
        }
        const selected = String(this.settings?.connectionProfile || '').trim();
        const allProfiles = this.getConnectionProfiles();
        const compatible = listGoogleNativeTtsConnectionProfiles(allProfiles);
        const compatibleNames = compatible.map(profile => profile.name);

        select.empty();
        const globalOpt = document.createElement('option');
        globalOpt.value = '';
        globalOpt.text = translate('Follow the chat connection');
        select.append(globalOpt);

        for (const name of compatibleNames) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.text = name;
            select.append(opt);
        }

        if (selected && !compatibleNames.includes(selected)) {
            const existsInAll = allProfiles.some(profile => String(profile?.name || '').trim() === selected);
            const suffix = existsInAll ? translate('(incompatible)') : translate('(missing)');
            const staleOpt = document.createElement('option');
            staleOpt.value = selected;
            staleOpt.text = `${selected} ${suffix}`;
            select.append(staleOpt);
        }

        select.val(selected);
    }

    async loadSettings(settings) {
        if (Object.keys(settings).length === 0) {
            console.info('Using default Google TTS Provider settings');
        }

        this.settings = { ...this.defaultSettings, ...settings };
        this.settings.connectionProfile = String(this.settings.connectionProfile || '').trim();

        $('#google-tts-api-type').val(this.settings.apiType);
        $('#google-tts-model').val(this.settings.model);
        this.renderConnectionProfileSelect();

        $('#google-tts-api-type, #google-tts-model').on('change', () => this.onSettingsChange({ resetVoices: true }));
        $('#google-tts-connection-profile').on('change', () => this.onSettingsChange({ resetVoices: false }));

        this.dispose();
        CONNECTION_PROFILE_EVENTS.forEach(event => {
            eventSource.on(event, this.onConnectionProfilesChanged);
        });

        this.renderConnStatus();

        try {
            await this.checkReady();
            console.debug('Google TTS: Settings loaded');
        } catch (err) {
            console.warn('Google TTS: Settings loaded, but not ready.', err.message);
        }
    }

    onSettingsChange({ resetVoices = true } = {}) {
        this.settings.apiType = $('#google-tts-api-type').val();
        this.settings.model = $('#google-tts-model').val();
        this.settings.connectionProfile = String($('#google-tts-connection-profile').val() || '').trim();

        if (resetVoices) {
            this.voices = []; // Reset voices cache so it re-fetches
        }
        saveTtsProviderSettings();
        this.renderConnStatus();
    }

    async checkReady() {
        await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        this.renderConnectionProfileSelect();
        this.renderConnStatus();
        await this.checkReady();
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }

        const match = this.voices.find(voice => voice.name === voiceName || voice.voice_id === voiceName);

        if (!match) {
            throw `TTS Voice name ${voiceName} not found`;
        }
        return match;
    }

    async generateTts(text, voiceId) {
        return await this.fetchNativeTtsGeneration(text, voiceId);
    }

    async fetchTtsVoiceObjects() {
        try {
            const response = await fetch('/api/google/list-native-voices', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({}),
            });

            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

                try {
                    const errorJson = await response.json();
                    if (errorJson.error) {
                        errorMessage = errorJson.error;
                    }
                } catch (parseError) {
                    // Response isn't valid JSON, use the HTTP error message
                    console.debug('Error response is not JSON:', parseError.message);
                }

                throw new Error(errorMessage);
            }

            const responseJson = await response.json();

            if (!responseJson.voices || !Array.isArray(responseJson.voices)) {
                throw new Error('Invalid response format: voices array not found');
            }

            this.voices = responseJson.voices;
            console.info(`Google TTS: Loaded ${this.voices.length} voices`);

            return this.voices;
        } catch (error) {
            console.error('Failed to fetch Google TTS voices:', error);
            throw error;
        }
    }

    async previewTtsVoice(id) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        try {
            const voice = await this.getVoice(id);
            const text = getPreviewString(voice.lang || 'en-US');

            const response = await this.fetchNativeTtsGeneration(text, id);

            if (!response.ok) {
                // Error is handled inside the fetch function, but we still need to stop here
                return;
            }

            const audioBlob = await response.blob();
            const url = URL.createObjectURL(audioBlob);
            this.audioElement.src = url;
            this.audioElement.play();
            this.audioElement.onended = () => URL.revokeObjectURL(url);
        } catch (error) {
            console.error('TTS Preview Error:', error);
            toastr.error(`Could not generate preview: ${error.message}`);
        }
    }

    localizeConnectionError(error) {
        const name = String(error?.profileName ?? this.settings?.connectionProfile ?? '').trim();
        switch (error?.code) {
            case 'profile_not_found':
                return t`Connection profile "${name}" was not found. TTS request aborted.`;
            case 'profile_incompatible':
                return t`Connection profile "${name}" is not Google AI Studio (MakerSuite). TTS request aborted.`;
            case 'profile_missing_secret':
                return t`Connection profile "${name}" has no saved API key. TTS request aborted.`;
            default:
                return String(error?.message ?? error);
        }
    }

    resolveConnection() {
        return resolveGoogleNativeTtsConnection({
            profileName: this.settings?.connectionProfile,
            profiles: this.getConnectionProfiles(),
            proxies,
            oaiSettings: oai_settings,
            isValidUrl,
        });
    }

    /**
     * Connection fields for native TTS generation requests: reverse_proxy / proxy_password / base_url / secret_id / strict_secret_id.
     * Empty connectionProfile follows the global chat connection.
     * A named connectionProfile resolves that MakerSuite profile and throws if missing, incompatible, or keyless (direct).
     */
    buildConnectionFields() {
        try {
            return this.resolveConnection().requestFields;
        } catch (error) {
            throw new Error(this.localizeConnectionError(error));
        }
    }

    /** Status line: profile name, whether a key slot is bound, and the endpoint hostname only (never keys or full URLs). */
    renderConnStatus() {
        const el = $('#google-tts-conn-status');
        if (!el.length) {
            return;
        }
        try {
            const resolved = this.resolveConnection();
            if (resolved.mode === 'global') {
                el.text(translate('Following the global chat connection.'));
                return;
            }
            const keyState = resolved.hasBoundSecret ? translate('yes') : translate('no');
            const endpoint = !resolved.endpointHost
                ? translate('Default')
                : (resolved.endpointHost === 'configured' ? translate('configured') : resolved.endpointHost);
            el.text(t`Profile: ${resolved.profileName} · Key bound: ${keyState} · Endpoint: ${endpoint}`);
        } catch (error) {
            el.text(this.localizeConnectionError(error));
        }
    }

    async fetchNativeTtsGeneration(text, voiceId) {
        console.info(`Generating native Google TTS for voice_id ${voiceId}`);

        const response = await fetch('/api/google/generate-native-tts', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: text,
                voice: voiceId,
                model: this.settings.model,
                api: this.settings.apiType,
                ...this.buildConnectionFields(),
                vertexai_auth_mode: oai_settings.vertexai_auth_mode,
                vertexai_region: oai_settings.vertexai_region,
                vertexai_express_project_id: oai_settings.vertexai_express_project_id,
            }),
        });

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            try {
                const errorJson = await response.json();
                if (errorJson.error) {
                    errorMessage = errorJson.error;
                }
            } catch {
                // Not a JSON response, do nothing and keep the original http error
            }
            throw new Error(errorMessage);
        }
        return response;
    }
}
