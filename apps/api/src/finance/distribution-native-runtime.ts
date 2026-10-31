import type { AppConfig } from '../config/config';
import { ConfigurationError } from '../config/config';
import { readFormalCollectionAdmission, type FormalCollectionAdmission } from '../order/joinpay-collection-profile';
import { createNativeDistributionPolicyScope } from './distribution-policy-store';
import { createNativeDistributionEarningStore } from './distribution-earning-store';

const nativeBindings = new WeakMap<ReturnType<typeof createNativeDistributionEarningStore>, {
  scope: ReturnType<typeof createNativeDistributionPolicyScope>; admission: FormalCollectionAdmission;
}>();

/** Only the loader's exact scope/store/admission combination may bypass local payment assembly. */
export function assertNativeDistributionEarningAssembly(
  earnings: ReturnType<typeof createNativeDistributionEarningStore>,
  scope: ReturnType<typeof createNativeDistributionPolicyScope> | undefined,
  admission: FormalCollectionAdmission | undefined,
): boolean {
  const bound = nativeBindings.get(earnings);
  if (!bound) return false;
  if (bound.scope !== scope || bound.admission !== admission) throw new ConfigurationError('NATIVE_DISTRIBUTION_ASSEMBLY_MISMATCH');
  return true;
}

/** Explicit formal NATIVE assembly only. No environment-derived ratio, policy, identity or admission. */
export function loadNativeDistributionRuntime(input: {
  config: Pick<AppConfig, 'provider' | 'database'>;
  authEnabled: boolean;
  admission: FormalCollectionAdmission | undefined;
  env?: NodeJS.ProcessEnv;
}) {
  const enabled = (input.env ?? process.env).DISTRIBUTION_NATIVE_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new ConfigurationError('DISTRIBUTION_NATIVE_ENABLED_INVALID');
  if (enabled === 'false') return undefined;
  if (!input.authEnabled || input.config.provider !== 'real' || input.config.database.user !== input.config.database.runtimeUser) {
    throw new ConfigurationError('DISTRIBUTION_NATIVE_RUNTIME_CONTEXT_INVALID');
  }
  if (!input.admission) throw new ConfigurationError('DISTRIBUTION_NATIVE_REQUIRES_FORMAL_COLLECTION_ADMISSION');
  const view = readFormalCollectionAdmission(input.admission);
  if (view.database !== input.config.database.name || view.runtimeUser !== input.config.database.user) {
    throw new ConfigurationError('DISTRIBUTION_NATIVE_RESOURCE_MISMATCH');
  }
  const distributionScope = createNativeDistributionPolicyScope(input.admission);
  const distributionEarnings = createNativeDistributionEarningStore(input.admission);
  nativeBindings.set(distributionEarnings, { scope: distributionScope, admission: input.admission });
  return Object.freeze({
    auth: Object.freeze({
      distributionScope,
      distributionReadScope: distributionScope,
      distributionEarnings,
    }),
  });
}
