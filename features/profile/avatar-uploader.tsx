'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowCounterClockwise,
  Camera,
  Check,
  ImageSquare,
  SpinnerGap,
  X,
} from '@phosphor-icons/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  AVATAR_MAX_ZOOM,
  AVATAR_MIN_ZOOM,
  DEFAULT_AVATAR_CROP,
  compressAvatar,
  drawAvatarCrop,
  loadAvatarImage,
  validateAvatarSource,
  type AvatarCrop,
} from '@/lib/avatar-image';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';

type AvatarFeedback = Readonly<{
  kind: 'status' | 'error';
  message: string;
}>;

function CropPreview({
  file,
  crop,
  previewLabel,
  onCropChange,
  onError,
}: {
  file: File;
  crop: AvatarCrop;
  previewLabel: string;
  onCropChange: (crop: AvatarCrop) => void;
  onError: (error: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let active = true;
    setImage(null);
    void loadAvatarImage(file).then(
      (loaded) => {
        if (active) setImage(loaded);
      },
      (error) => {
        if (active) onError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [file, onError]);

  useEffect(() => {
    if (!image || !canvasRef.current) return;
    drawAvatarCrop(image, canvasRef.current, crop, 360, 360);
  }, [crop, image]);

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      pinchRef.current = {
        distance: Math.hypot(second!.x - first!.x, second!.y - first!.y),
        zoom: crop.zoom,
      };
    }
  };

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      const width = Math.max(1, event.currentTarget.clientWidth);
      const height = Math.max(1, event.currentTarget.clientHeight);
      onCropChange({
        ...crop,
        offsetX: Math.max(
          -1,
          Math.min(1, crop.offsetX - ((event.clientX - previous.x) / width) * 2),
        ),
        offsetY: Math.max(
          -1,
          Math.min(1, crop.offsetY - ((event.clientY - previous.y) / height) * 2),
        ),
      });
      return;
    }

    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [first, second] = [...pointersRef.current.values()];
      const distance = Math.hypot(second!.x - first!.x, second!.y - first!.y);
      const nextZoom = pinchRef.current.zoom * (distance / Math.max(1, pinchRef.current.distance));
      onCropChange({
        ...crop,
        zoom: Math.max(AVATAR_MIN_ZOOM, Math.min(AVATAR_MAX_ZOOM, nextZoom)),
      });
    }
  };

  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      width={360}
      height={360}
      className="aspect-square h-auto w-full touch-none rounded-2xl bg-[var(--color-surface-muted)] object-cover"
      aria-label={previewLabel}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
    />
  );
}

function cameraFile(video: HTMLVideoElement) {
  return new Promise<File>((resolve, reject) => {
    if (!video.videoWidth || !video.videoHeight) {
      reject(new Error('CAMERA_NOT_READY'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      reject(new Error('AVATAR_CANVAS_UNAVAILABLE'));
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('CAMERA_CAPTURE_FAILED'));
          return;
        }
        resolve(new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92,
    );
  });
}

export function AvatarUploader({
  initialUrl,
  initials,
  required = false,
  compact = false,
  onUploaded,
}: {
  initialUrl: string | null;
  initials: string;
  required?: boolean;
  compact?: boolean;
  onUploaded?: (signedUrl: string) => void;
}) {
  const t = useTranslations('Avatar');
  const tErrors = useTranslations('Common.errors');
  const photoActionsId = useId();
  const cropTitleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const cropPanelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const [avatarUrl, setAvatarUrl] = useState(initialUrl);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [crop, setCrop] = useState<AvatarCrop>(DEFAULT_AVATAR_CROP);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<AvatarFeedback | null>(null);
  const [photoActionsOpen, setPhotoActionsOpen] = useState(!compact);

  const avatarErrorMessage = useCallback(
    (error: unknown) => {
      if (error instanceof Error) {
        if (error.message === 'AVATAR_SOURCE_TOO_LARGE') return t('errors.sourceTooLarge');
        if (error.message === 'AVATAR_IMAGE_REQUIRED') return t('errors.imageRequired');
        if (error.message === 'AVATAR_IMAGE_INVALID') return t('errors.imageInvalid');
        if (error.message === 'AVATAR_TOO_COMPLEX') return t('errors.tooComplex');
        if (error.message === 'AVATAR_DIMENSIONS_INVALID') return t('errors.dimensionsInvalid');
        if (error.message === 'AVATAR_UPLOAD_IN_PROGRESS') return t('errors.uploadInProgress');
      }
      return localizedClientRequestMessage(error, t('errors.uploadFailed'), tErrors);
    },
    [t, tErrors],
  );

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStarting(false);
    setCameraReady(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const stopOnPageHide = () => {
      cameraRequestRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    const stopWhenHidden = () => {
      if (document.visibilityState === 'hidden') stopOnPageHide();
    };
    window.addEventListener('pagehide', stopOnPageHide);
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => {
      mountedRef.current = false;
      cameraRequestRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      window.removeEventListener('pagehide', stopOnPageHide);
      document.removeEventListener('visibilitychange', stopWhenHidden);
    };
  }, []);

  useEffect(() => {
    if (!candidate) return;
    const frame = requestAnimationFrame(() => {
      const panel = cropPanelRef.current;
      if (!panel) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      panel.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [candidate]);

  const chooseCandidate = useCallback((file: File) => {
    try {
      validateAvatarSource(file);
      setCandidate(file);
      setCrop(DEFAULT_AVATAR_CROP);
      setFeedback({
        kind: 'status',
        message: t('selected'),
      });
    } catch (error) {
      setCandidate(null);
      setFeedback({ kind: 'error', message: avatarErrorMessage(error) });
    }
  }, [avatarErrorMessage, t]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && !busy) {
      stopCamera();
      setCameraOpen(false);
      setCameraError('');
      chooseCandidate(file);
    }
  };

  const startCamera = async () => {
    if (busy) return;
    stopCamera();
    setCandidate(null);
    setFeedback(null);
    setCameraOpen(true);
    setCameraError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraOpen(false);
      setFeedback({
        kind: 'status',
        message: t('cameraUnavailable'),
      });
      captureInputRef.current?.click();
      return;
    }

    const requestId = cameraRequestRef.current + 1;
    cameraRequestRef.current = requestId;
    setCameraStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' } },
        audio: false,
      });
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCameraReady(true);
    } catch (error) {
      if (!mountedRef.current || requestId !== cameraRequestRef.current) return;
      const denied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setCameraError(
        denied
          ? t('cameraDenied')
          : t('cameraFailed'),
      );
    } finally {
      if (mountedRef.current && requestId === cameraRequestRef.current) setCameraStarting(false);
    }
  };

  const closeCamera = () => {
    stopCamera();
    setCameraOpen(false);
    setCameraError('');
  };

  const takePhoto = async () => {
    if (!videoRef.current || !streamRef.current) return;
    setBusy(true);
    try {
      const file = await cameraFile(videoRef.current);
      stopCamera();
      setCameraOpen(false);
      chooseCandidate(file);
    } catch {
      setCameraError(t('cameraNotReady'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!candidate || busy) return;
    setBusy(true);
    setFeedback({ kind: 'status', message: t('processing') });
    try {
      const avatar = await compressAvatar(candidate, crop);
      const body = new FormData();
      const extension = avatar.type === 'image/jpeg' ? 'jpg' : 'webp';
      body.set('avatar', new File([avatar], `avatar.${extension}`, { type: avatar.type }));
      const result = await clientRequest('/api/profile/avatar', {
        method: 'POST',
        body,
      });
      const payload = await readClientResponseJson<{
        avatarUrl?: unknown;
        bytes?: unknown;
        error?: unknown;
      }>(
        result.response,
      );
      if (!result.ok || typeof payload?.avatarUrl !== 'string') {
        if (!result.ok && typeof payload?.error === 'string') throw new Error(payload.error);
        throw result.ok ? new Error('AVATAR_UPLOAD_INVALID') : result.error;
      }
      setAvatarUrl(payload.avatarUrl);
      setCandidate(null);
      setCrop(DEFAULT_AVATAR_CROP);
      if (compact) setPhotoActionsOpen(false);
      const bytes = typeof payload.bytes === 'number' ? payload.bytes : avatar.size;
      setFeedback({
        kind: 'status',
        message: t('saved', { kilobytes: Math.ceil(bytes / 1024) }),
      });
      onUploaded?.(payload.avatarUrl);
    } catch (error) {
      setFeedback({ kind: 'error', message: avatarErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const updateCrop = (field: keyof AvatarCrop) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setCrop((current) => ({ ...current, [field]: Number(event.target.value) }));
  };

  const previewError = useCallback((value: unknown) => {
    setCandidate(null);
    setFeedback({ kind: 'error', message: avatarErrorMessage(value) });
  }, [avatarErrorMessage]);

  return (
    <div className={compact ? 'space-y-2 text-center' : 'space-y-4 text-center'}>
      <Avatar
        className={`${compact ? 'size-24' : 'size-32'} mx-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] shadow-sm`}
      >
        {avatarUrl ? (
          <AvatarImage
            src={avatarUrl}
            alt={t('profilePhoto')}
            className="aspect-square size-full rounded-2xl object-cover"
          />
        ) : null}
        <AvatarFallback className="rounded-2xl text-xl font-bold">{initials}</AvatarFallback>
      </Avatar>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={onFileChange}
        aria-label={t('chooseAria')}
      />
      <input
        ref={captureInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="user"
        className="sr-only"
        onChange={onFileChange}
        aria-label={t('systemCameraAria')}
      />

      {compact && !photoActionsOpen ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-expanded="false"
          aria-controls={photoActionsId}
          onClick={() => setPhotoActionsOpen(true)}
        >
          <Camera size={17} /> {t('change')}
        </Button>
      ) : (
        <div id={photoActionsId} className="flex flex-wrap justify-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={startCamera}>
            <Camera size={17} /> {t('take')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageSquare size={17} /> {t('choose')}
          </Button>
          {compact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPhotoActionsOpen(false);
                setCandidate(null);
                setFeedback(null);
              }}
            >
              {t('close')}
            </Button>
          ) : null}
        </div>
      )}

      {candidate ? (
        <div
          data-avatar-crop-panel
          ref={cropPanelRef}
          tabIndex={-1}
          aria-labelledby={cropTitleId}
          className="mx-auto max-w-sm space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          <div className="space-y-1">
            <h3 id={cropTitleId} className="font-display text-base font-bold">
              {t('cropTitle')}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('cropDescription')}
            </p>
          </div>
          <CropPreview
            file={candidate}
            crop={crop}
            previewLabel={t('cropPreview')}
            onCropChange={setCrop}
            onError={previewError}
          />
          <div className="space-y-3">
            <label className="block text-xs font-semibold">
              {t('zoom')}
              <input
                type="range"
                min={AVATAR_MIN_ZOOM}
                max={AVATAR_MAX_ZOOM}
                step="0.05"
                value={crop.zoom}
                onChange={updateCrop('zoom')}
                className="mt-1 block w-full accent-[var(--color-primary)]"
              />
            </label>
            <label className="block text-xs font-semibold">
              {t('horizontal')}
              <input
                type="range"
                min="-1"
                max="1"
                step="0.02"
                value={crop.offsetX}
                onChange={updateCrop('offsetX')}
                className="mt-1 block w-full accent-[var(--color-primary)]"
              />
            </label>
            <label className="block text-xs font-semibold">
              {t('vertical')}
              <input
                type="range"
                min="-1"
                max="1"
                step="0.02"
                value={crop.offsetY}
                onChange={updateCrop('offsetY')}
                className="mt-1 block w-full accent-[var(--color-primary)]"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={upload}
              className="col-span-2 w-full sm:order-3 sm:w-auto"
            >
              {busy ? <SpinnerGap size={17} className="animate-spin" /> : <Check size={17} />}
              {t('usePhoto')}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={startCamera}>
              <ArrowCounterClockwise size={17} /> {t('retake')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setCandidate(null);
                setFeedback(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {!compact || photoActionsOpen ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {required ? t('requiredPrefix') : ''}
          {t('requirements')}
        </p>
      ) : null}
      {feedback ? (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`text-xs ${feedback.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {feedback.message}
        </p>
      ) : null}

      {cameraOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="camera-title"
          className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-black/70 p-4"
        >
          <div className="w-full max-w-lg space-y-4 rounded-[var(--radius-lg)] bg-[var(--color-surface)] p-4 text-left shadow-[var(--shadow-pop)] sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 id="camera-title" className="font-display text-xl font-bold">
                {t('cameraTitle')}
              </h2>
              <Button type="button" variant="ghost" size="icon" onClick={closeCamera}>
                <X size={20} /> <span className="sr-only">{t('closeCamera')}</span>
              </Button>
            </div>
            <div className="mx-auto aspect-square max-h-[62vh] overflow-hidden rounded-2xl bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className="size-full -scale-x-100 object-cover"
                aria-label={t('cameraPreview')}
              />
            </div>
            {cameraStarting ? (
              <p role="status" className="flex items-center gap-2 text-sm">
                <SpinnerGap size={18} className="animate-spin" /> {t('openingCamera')}
              </p>
            ) : null}
            {cameraError ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {cameraError}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              {cameraError ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => captureInputRef.current?.click()}
                >
                  <Camera size={17} /> {t('systemCamera')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={cameraStarting || busy}
                  onClick={startCamera}
                >
                  <ArrowCounterClockwise size={17} /> {t('restart')}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={cameraStarting || busy || !cameraReady}
                onClick={takePhoto}
              >
                <Camera size={17} /> {t('capture')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
