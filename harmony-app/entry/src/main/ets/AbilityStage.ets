import { AbilityStage } from '@kit.AbilityKit';

export default class LukerAbilityStage extends AbilityStage {
  onCreate(): void {
    console.info('[LukerAbilityStage] onCreate');
  }
}
