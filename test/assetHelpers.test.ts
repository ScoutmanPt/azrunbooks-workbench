import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_DESCRIPTION_KEY,
  CONNECTION_TYPE_KEY,
  connectionSettingsFromAzure,
  credentialSettingsFromAzure,
  normalizeAutomationVariableValue,
  parseConnectionSettingsForAzure,
} from '../src/assetHelpers';

describe('assetHelpers', () => {
  it('credentialSettingsFromAzure seeds username and blank password', () => {
    assert.deepEqual(credentialSettingsFromAzure('user@contoso.com'), {
      Username: 'user@contoso.com',
      Password: '',
    });
  });

  it('connectionSettingsFromAzure stores type, description, and field values', () => {
    assert.deepEqual(
      connectionSettingsFromAzure('AzureServicePrincipal', { TenantId: 'abc' }, 'demo'),
      {
        TenantId: 'abc',
        [CONNECTION_TYPE_KEY]: 'AzureServicePrincipal',
        [CONNECTION_DESCRIPTION_KEY]: 'demo',
      }
    );
  });

  it('parseConnectionSettingsForAzure splits metadata from field values', () => {
    assert.deepEqual(
      parseConnectionSettingsForAzure({
        [CONNECTION_TYPE_KEY]: 'AzureServicePrincipal',
        [CONNECTION_DESCRIPTION_KEY]: 'demo',
        TenantId: 'abc',
        ApplicationId: '123',
      }),
      {
        connectionType: 'AzureServicePrincipal',
        description: 'demo',
        fieldValues: {
          TenantId: 'abc',
          ApplicationId: '123',
        },
      }
    );
  });

  it('normalizeAutomationVariableValue unwraps JSON string literals', () => {
    assert.equal(normalizeAutomationVariableValue('"def"'), 'def');
    assert.equal(normalizeAutomationVariableValue('"rodrigopinto"'), 'rodrigopinto');
  });

  it('normalizeAutomationVariableValue preserves plain strings and JSON objects', () => {
    assert.equal(normalizeAutomationVariableValue('def'), 'def');
    assert.equal(
      normalizeAutomationVariableValue('{"TenantId":"abc","ClientId":"123"}'),
      '{"TenantId":"abc","ClientId":"123"}'
    );
  });
});
