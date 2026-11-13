import crashSummaryTest from './CrashSummary.test';
import fileSelectionPlannerTest from './FileSelectionPlanner.test';
import backendEntryParamsTest from './BackendEntryParams.test';
import externalLinkPolicyTest from './ExternalLinkPolicy.test';
import endpointUrlTest from './EndpointUrl.test';
import endpointFailureTest from './EndpointFailure.test';
import httpAuthTest from './HttpAuth.test';
import webRecoveryStateTest from './WebRecoveryState.test';

export default function testsuite(): void {
  crashSummaryTest();
  fileSelectionPlannerTest();
  backendEntryParamsTest();
  externalLinkPolicyTest();
  endpointUrlTest();
  endpointFailureTest();
  httpAuthTest();
  webRecoveryStateTest();
}
