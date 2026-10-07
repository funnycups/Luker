import { AbilityStage } from '@kit.AbilityKit';
import { installCrashWatcher } from './crash/CrashCapture';

export default class LukerAbilityStage extends AbilityStage {
  onCreate(): void {
    installCrashWatcher(this.context.filesDir);
  }
}
