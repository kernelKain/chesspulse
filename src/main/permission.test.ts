import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grantsMediaPermission, type MediaPermissionInput } from './permission.js';

function request(overrides: Partial<MediaPermissionInput> = {}): MediaPermissionInput {
  return {
    permission: 'media',
    requestingUrl: 'file:///tmp/chesspulse/index.html',
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

  it('denies the dev server and any remote page', () => {
    assert.equal(
      grantsMediaPermission(request({ requestingUrl: 'http://127.0.0.1:5173/' })),
      false,
    );
    assert.equal(
      grantsMediaPermission(request({ requestingUrl: 'https://example.com/' })),
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
