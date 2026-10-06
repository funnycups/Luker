import { killNode } from 'libnode_ctl.so';

export class BackendManager {
  static pid: number = -1;
  static inProcess: boolean = false;
  static dataDir: string = '';
  static entryParams: string = '';
  static launchAttempted: boolean = false;

  static setPid(pid: number): void {
    BackendManager.pid = pid;
    BackendManager.inProcess = false;
  }

  static setInProcess(): void {
    BackendManager.inProcess = true;
    BackendManager.pid = -1;
  }

  static killBackend(): void {
    if (BackendManager.inProcess) {
      return;
    }
    if (BackendManager.pid > 0) {
      try {
        killNode(BackendManager.pid);
      } catch {
        // child already gone
      }
      BackendManager.pid = -1;
    }
  }
}
