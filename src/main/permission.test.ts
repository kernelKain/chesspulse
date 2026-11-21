import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grantsMediaPermission, type MediaPermissionInput } from './permission.js';

function request(overrides: Partial<MediaPermissionInput> = {}): MediaPermissionInput {
  return {
    permission: 'media',
    requestingUrl: 'file:///tmp/chesspulse/index.html',
    appFileUrl: 'file:///tmp/chesspulse/index.html',
    consentGranted: true,
    isMainFrame: true,
    mediaTypes: ['video'],
    ...overrides,
  };
}

describe('grantsMediaPermission', () => {
  it('allows the camera on a local file after consent', () => {
    assert.equal(grantsMediaPermission(request()), true);
  });

  it('denies the camera when consent is absent', () => {
    assert.equal(grantsMediaPermission(request({ consentGranted: false })), false);
  });

  it('denies a different local file', () => {
    assert.equal(
      grantsMediaPermission(request({ requestingUrl: 'file:///tmp/other/index.html' })),
      false,
    );
  });

  it('denies the dev server when no dev origin is configured', () => {
    assert.equal(
      grantsMediaPermission(request({ requestingUrl: 'http://127.0.0.1:5173/' })),
      false,
    );
    assert.equal(
      grantsMediaPermission(request({ requestingUrl: 'https://example.com/' })),
      false,
    );
  });

  it('allows only the configured dev origin', () => {
    const devOrigin = 'http://127.0.0.1:5173';
    assert.equal(
      grantsMediaPermission(
        request({ requestingUrl: 'http://127.0.0.1:5173/', devOrigin }),
      ),
      true,
    );
    assert.equal(
      grantsMediaPermission(
        request({ requestingUrl: 'http://127.0.0.1:5174/', devOrigin }),
      ),
      false,
    );
    assert.equal(
      grantsMediaPermission(
        request({ requestingUrl: 'https://example.com/', devOrigin }),
      ),
      false,
    );
  });

  it('denies microphone, screen capture, and subframe requests', () => {
    assert.equal(grantsMediaPermission(request({ mediaTypes: ['video', 'audio'] })), false);
    assert.equal(grantsMediaPermission(request({ mediaTypes: undefined, mediaType: 'audio' })), false);
    assert.equal(grantsMediaPermission(request({ permission: 'display-capture' })), false);
    assert.equal(grantsMediaPermission(request({ isMainFrame: false })), false);
  });
});
