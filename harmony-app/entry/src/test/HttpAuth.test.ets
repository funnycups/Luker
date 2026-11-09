import { describe, it, expect } from '@ohos/hypium';
import {
  HttpAuthCredentials,
  decideHttpAuth,
  httpAuthKey,
  sameHttpAuthCredentials,
} from '../main/ets/HttpAuth';

export default function httpAuthTest(): void {
  describe('HttpAuth', () => {
    it('reuses stored credentials until the server rejects them', 0, () => {
      const stored: HttpAuthCredentials = { username: 'user', password: 'secret' };
      const first = decideHttpAuth(stored, null);
      expect(first.useStored).assertTrue();
      expect(first.clearStored).assertFalse();
      expect(first.stored !== null && first.stored.username === 'user'
        && first.stored.password === 'secret').assertTrue();
      expect(first.prefill === null).assertTrue();

      const rejected = decideHttpAuth(stored, stored);
      expect(rejected.useStored).assertFalse();
      expect(rejected.clearStored).assertTrue();
      expect(rejected.prefill !== null && rejected.prefill.username === 'user'
        && rejected.prefill.password === 'secret').assertTrue();
    });

    it('prompts with the last attempt when nothing is stored', 0, () => {
      const attempted: HttpAuthCredentials = { username: 'user', password: 'wrong' };
      const decision = decideHttpAuth(null, attempted);
      expect(decision.useStored).assertFalse();
      expect(decision.clearStored).assertFalse();
      expect(decision.prefill !== null && decision.prefill.username === 'user'
        && decision.prefill.password === 'wrong').assertTrue();
    });

    it('prompts with empty prefill on the first challenge', 0, () => {
      const decision = decideHttpAuth(null, null);
      expect(decision.useStored).assertFalse();
      expect(decision.clearStored).assertFalse();
      expect(decision.prefill === null).assertTrue();
    });

    it('compares credentials by value', 0, () => {
      const first: HttpAuthCredentials = { username: 'user', password: 'secret' };
      const same: HttpAuthCredentials = { username: 'user', password: 'secret' };
      const changed: HttpAuthCredentials = { username: 'user', password: 'changed' };
      expect(sameHttpAuthCredentials(first, same)).assertTrue();
      expect(sameHttpAuthCredentials(first, changed)).assertFalse();
      expect(sameHttpAuthCredentials(null, null)).assertTrue();
      expect(sameHttpAuthCredentials(null, first)).assertFalse();
    });

    it('keys by normalized host and realm', 0, () => {
      expect(httpAuthKey('Example.COM', ' Realm ')).assertEqual('example.com|Realm');
    });
  });
}
