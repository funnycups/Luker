import { describe, it, expect } from '@ohos/hypium';
import {
  shouldShowEndpointFailureForError,
  shouldShowEndpointFailureForStatus,
} from '../main/ets/EndpointFailure';

export default function endpointFailureTest(): void {
  describe('EndpointFailure', () => {
    it('shows for a main frame 404', 0, () => {
      expect(shouldShowEndpointFailureForStatus(404, true)).assertTrue();
    });

    it('shows for main frame 5xx responses', 0, () => {
      expect(shouldShowEndpointFailureForStatus(500, true)).assertTrue();
      expect(shouldShowEndpointFailureForStatus(599, true)).assertTrue();
    });

    it('ignores auth, rate limit and other 4xx responses', 0, () => {
      expect(shouldShowEndpointFailureForStatus(401, true)).assertFalse();
      expect(shouldShowEndpointFailureForStatus(403, true)).assertFalse();
      expect(shouldShowEndpointFailureForStatus(429, true)).assertFalse();
      expect(shouldShowEndpointFailureForStatus(400, true)).assertFalse();
      expect(shouldShowEndpointFailureForStatus(499, true)).assertFalse();
    });

    it('ignores subframe responses', 0, () => {
      expect(shouldShowEndpointFailureForStatus(404, false)).assertFalse();
      expect(shouldShowEndpointFailureForStatus(500, false)).assertFalse();
    });

    it('ignores a canceled navigation', 0, () => {
      expect(shouldShowEndpointFailureForError('net::ERR_ABORTED', true)).assertFalse();
    });

    it('shows for a main frame connection error', 0, () => {
      expect(shouldShowEndpointFailureForError('net::ERR_CONNECTION_REFUSED', true))
        .assertTrue();
    });

    it('ignores subframe errors', 0, () => {
      expect(shouldShowEndpointFailureForError('net::ERR_CONNECTION_REFUSED', false))
        .assertFalse();
    });
  });
}
