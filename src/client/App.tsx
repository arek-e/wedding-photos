import { AnimatePresence, motion } from "motion/react";
import QRCode from "qrcode";
import { ViewTransition, startTransition, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { useLiveQuery } from "@tanstack/react-db";
import { Popover } from "@base-ui/react/popover";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  addPendingPhotos,
  galleryCollection,
  removeGalleryPhoto,
  syncServerPhotos,
  type GalleryPhoto,
} from "./galleryStore";
import { cn } from "./lib/utils";
import {
  CreateEventResponse,
  GalleryResponse,
  LoginResponse,
  OkResponse,
  SessionResponse,
  UploadResponse,
  type CreateEventResponse as CreatedRoom,
  type SessionResponse as Session,
} from "../shared/api";

type Tab = "all" | "personal";
type View = "camera" | "gallery" | "detail";

const requestJson = async <A, I>(
  schema: Schema.Schema<A, I, never>,
  input: RequestInfo,
  init?: RequestInit,
): Promise<A> => {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
  return Schema.decodeUnknownPromise(schema)(data);
};

const queryCode = () => new URLSearchParams(window.location.search).get("code") ?? "";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<View>("camera");
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const { data: photos } = useLiveQuery((q) =>
    q.from({ photo: galleryCollection }).select(({ photo }) => photo),
  );

  if (window.location.pathname === "/admin") {
    return <Admin />;
  }

  const remaining = session?.remaining ?? session?.maxPhotos ?? 20;
  const personalPhotos = [...photos]
    .filter((photo) => photo.isMine)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const visiblePhotos = [
    ...(tab === "personal" ? photos.filter((photo) => photo.isMine) : photos),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId) ?? null;

  const goToView = (nextView: View, photoId?: string) => {
    startTransition(() => {
      if (photoId !== undefined) setSelectedPhotoId(photoId);
      setView(nextView);
    });
  };

  const refresh = async () => {
    const [{ photos: nextPhotos }, nextSession] = await Promise.all([
      requestJson(GalleryResponse, "/api/gallery?scope=all"),
      requestJson(SessionResponse, `/api/session?code=${encodeURIComponent(queryCode())}`),
    ]);
    syncServerPhotos(nextPhotos);
    startTransition(() => {
      setSession(nextSession);
    });
  };

  useEffect(() => {
    requestJson(SessionResponse, `/api/session?code=${encodeURIComponent(queryCode())}`)
      .then((nextSession) => {
        setSession(nextSession);
        if (nextSession.guest) return refresh();
        return undefined;
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    if (!session?.guest || view !== "camera" || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        streamRef.current = null;
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [session?.guest?.id, view]);

  const reconcileUploads = async () => {
    for (const delay of [900, 1500, 2500, 4000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await refresh();
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError("");

    let pendingPhotos: ReadonlyArray<GalleryPhoto> = [];
    try {
      const body = new FormData();
      const fileArray = [...files];
      pendingPhotos = fileArray.map((file) => ({
        id: crypto.randomUUID(),
        guestName: session?.guest?.name ?? "You",
        filename: file.name,
        size: file.size,
        createdAt: new Date().toISOString(),
        isMine: true,
        url: URL.createObjectURL(file),
        uploadState: "pending" as const,
      }));
      addPendingPhotos(pendingPhotos);
      fileArray.forEach((file) => body.append("photos", file));
      body.append("clientIds", JSON.stringify(pendingPhotos.map((photo) => photo.id)));
      await requestJson(UploadResponse, "/api/upload", { method: "POST", body });
      void reconcileUploads();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload photo.");
      for (const photo of pendingPhotos) {
        removeGalleryPhoto(photo.id);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const captureLivePhoto = async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current || video.readyState < 2) {
      inputRef.current?.click();
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) {
      inputRef.current?.click();
      return;
    }

    const file = new File([blob], `wedding-${Date.now()}.jpg`, { type: "image/jpeg" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    await upload(transfer.files);
  };

  const removePhoto = async (photo: GalleryPhoto) => {
    if (!photo.isMine) return;
    removeGalleryPhoto(photo.id);
    if (photo.uploadState === "pending") return;
    try {
      await requestJson(OkResponse, `/api/photos/${photo.id}`, { method: "DELETE" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove photo.");
      await refresh();
    }
  };

  if (!session) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-950 text-amber-50">
        Loading camera...
      </main>
    );
  }

  if (!session.guest) {
    return <Login initialCode={session.eventCode || queryCode()} onLogin={setSession} />;
  }

  if (view === "gallery") {
    return (
      <ViewTransition name="gallery-view">
        <GalleryView
          tab={tab}
          photos={visiblePhotos}
          allCount={photos.length}
          personalCount={personalPhotos.length}
          onBack={() => goToView("camera")}
          onOpenPhoto={(photo) => goToView("detail", photo.id)}
          onRemove={removePhoto}
          onTabChange={setTab}
        />
      </ViewTransition>
    );
  }

  if (view === "detail" && selectedPhoto) {
    return (
      <ViewTransition name="detail-view">
        <PhotoDetailView
          photo={selectedPhoto}
          onBack={() => goToView("gallery")}
          onRemove={removePhoto}
        />
      </ViewTransition>
    );
  }

  return (
    <ViewTransition name="camera-view">
      <main className="relative min-h-screen overflow-hidden bg-black p-0 text-stone-50 md:bg-stone-200 md:p-5">
        <section className="relative mx-auto grid h-dvh w-full grid-rows-[auto_1fr_auto] overflow-hidden bg-black shadow-2xl md:h-[calc(100vh-40px)] md:max-w-[1180px] md:rounded-[36px] md:border-[10px] md:border-stone-950">
          <video
            ref={videoRef}
            className="absolute inset-0 size-full object-cover opacity-90"
            autoPlay
            muted
            playsInline
          />
          <div className="absolute inset-0 bg-black/25" />
          <header className="z-10 grid grid-cols-[1fr_auto] items-center gap-4 p-4 md:grid-cols-[1fr_auto_1fr] md:p-6">
            <div />
            <UserMenu
              name={session.guest.name}
              onSignOut={async () => {
                await requestJson(OkResponse, "/api/logout", { method: "POST" });
                setSession({ guest: null, eventCode: queryCode(), maxPhotos: 20 });
              }}
            />
          </header>

          <div className="pointer-events-none absolute inset-[18%_10%_34%] border border-white/20 md:inset-[22%_22%_28%]">
            <span className="absolute -left-px -top-px size-8 border-l-2 border-t-2 border-white" />
            <span className="absolute -right-px -top-px size-8 border-r-2 border-t-2 border-white" />
            <span className="absolute -bottom-px -left-px size-8 border-b-2 border-l-2 border-white" />
            <span className="absolute -bottom-px -right-px size-8 border-b-2 border-r-2 border-white" />
          </div>

          <motion.div
            className="mx-auto mb-[8vh] w-[min(660px,calc(100%-40px))] self-end text-center md:mb-0 md:self-center"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-white/70">
              {session.guest.name}'s camera
            </p>
            <h1 className="font-serif text-[clamp(3rem,11vw,7.8rem)] leading-[0.82] text-balance">
              Catch a real moment.
            </h1>
          </motion.div>

          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={busy || remaining === 0}
            onChange={(event) => void upload(event.currentTarget.files)}
          />
          <input
            ref={uploadInputRef}
            className="hidden"
            type="file"
            accept="image/*"
            multiple
            disabled={busy || remaining === 0}
            onChange={(event) => void upload(event.currentTarget.files)}
          />

          <footer className="z-10 grid grid-cols-[1fr_auto_1fr] items-end gap-3 p-4 md:p-6">
            <div className="grid justify-self-start gap-3">
              <Button
                className="h-11 rounded-full border border-white/20 bg-stone-950 px-4 text-[0.68rem] uppercase tracking-wide text-white shadow-lg"
                type="button"
                disabled={busy || remaining === 0}
                onClick={() => uploadInputRef.current?.click()}
              >
                Upload
              </Button>
              <motion.div
                className="grid min-w-20 grid-cols-[auto_auto] items-end gap-2 rounded-[22px] border border-white/20 bg-stone-950 px-3 py-2 md:min-w-28 md:px-4 md:py-3"
                layout
                aria-live="polite"
              >
                <span className="text-[0.68rem] font-black uppercase text-white/55 md:text-xs">
                  left
                </span>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.strong
                    key={remaining}
                    className="inline-block font-serif text-4xl leading-[0.8] md:text-5xl"
                    initial={{ y: 18, opacity: 0, scale: 0.8 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={{ y: -18, opacity: 0, scale: 0.8 }}
                  >
                    {remaining}
                  </motion.strong>
                </AnimatePresence>
              </motion.div>
            </div>

            <motion.div whileTap={{ scale: 0.86 }}>
              <Button
                variant="shutter"
                type="button"
                disabled={busy || remaining === 0}
                onClick={() => void captureLivePhoto()}
                aria-label="Take photo"
              >
                <span className="size-12 rounded-full bg-amber-50 md:size-14" />
              </Button>
            </motion.div>

            <Button
              className="size-16 justify-self-end rounded-full border border-white/20 bg-stone-950 p-0 text-[0.68rem] uppercase tracking-wide text-white shadow-lg md:size-20"
              type="button"
              onClick={() => goToView("gallery")}
            >
              Gallery
            </Button>
          </footer>
        </section>
        <AnimatePresence>
          {error ? <Toast message={error} onClose={() => setError("")} /> : null}
        </AnimatePresence>
      </main>
    </ViewTransition>
  );
}

function Admin() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [createdRoom, setCreatedRoom] = useState<CreatedRoom | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!createdRoom) return;
    QRCode.toDataURL(createdRoom.joinUrl, {
      margin: 2,
      width: 320,
      color: { dark: "#1c1917", light: "#fff7ed" },
    })
      .then(setQrCode)
      .catch(() => setError("Room was created, but QR code generation failed."));
  }, [createdRoom]);

  return (
    <main className="min-h-screen bg-stone-100 p-5 text-stone-950">
      <section className="mx-auto grid min-h-[calc(100vh-40px)] w-full max-w-5xl items-center gap-8 md:grid-cols-[0.9fr_1.1fr]">
        <motion.form
          className="grid gap-4 rounded-[28px] border border-stone-200 bg-white p-6 shadow-sm"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setQrCode("");
            try {
              const room = await requestJson(CreateEventResponse, "/api/admin/events", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name, code }),
              });
              setCreatedRoom(room);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not create room.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-xs font-black uppercase tracking-[0.16em] text-stone-500">
            Admin room builder
          </p>
          <h1 className="font-serif text-[clamp(3rem,11vw,6rem)] leading-[0.82]">
            Create a wedding room.
          </h1>
          <AdminField
            label="Event name"
            value={name}
            placeholder="Lana & Alex"
            onChange={setName}
          />
          <AdminField label="Room code" value={code} placeholder="LANAALEX" onChange={setCode} />
          {error ? (
            <p className="rounded-2xl bg-red-50 p-3 font-black text-red-800">{error}</p>
          ) : null}
          <Button disabled={busy} type="submit">
            Create room and QR
          </Button>
          <a className="font-black text-stone-600 underline" href="/">
            Back to guest camera
          </a>
        </motion.form>

        <motion.div
          className="grid min-h-[520px] place-items-center rounded-[28px] border border-stone-200 bg-white p-6 text-stone-950 shadow-sm"
          initial={{ opacity: 0, rotate: 1 }}
          animate={{ opacity: 1, rotate: 0 }}
        >
          {createdRoom ? (
            <div className="grid gap-5 text-center">
              <div>
                <p className="text-sm font-black uppercase tracking-[0.16em] text-stone-500">
                  Room code
                </p>
                <h2 className="font-serif text-6xl leading-none">{createdRoom.event.code}</h2>
                <p className="mt-2 font-black text-stone-950/60">{createdRoom.event.name}</p>
              </div>
              {qrCode ? (
                <img
                  className="mx-auto rounded-3xl border border-stone-200 shadow-sm"
                  src={qrCode}
                  alt="Join room QR code"
                />
              ) : null}
              <a
                className="break-all rounded-2xl bg-stone-950 p-4 font-black text-white"
                href={createdRoom.joinUrl}
              >
                {createdRoom.joinUrl}
              </a>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm font-black uppercase tracking-[0.16em] text-stone-500">
                QR preview
              </p>
              <p className="mt-3 font-serif text-4xl leading-none text-stone-950/70">
                Create a room to get a scannable guest link.
              </p>
            </div>
          )}
        </motion.div>
      </section>
    </main>
  );
}

function AdminField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="grid gap-2 font-black text-stone-600">
      {label}
      <input
        className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-stone-400 focus:ring-4 focus:ring-stone-200"
        value={value}
        type={type}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        required={label !== "Room code"}
      />
    </label>
  );
}

function Login({
  initialCode,
  onLogin,
}: {
  initialCode: string;
  onLogin: (session: Session) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-5 text-stone-950">
      <motion.form
        className="grid w-[min(480px,100%)] gap-4 rounded-[28px] border border-stone-200 bg-white p-7 shadow-sm"
        initial={{ opacity: 0, y: 24, rotate: -1 }}
        animate={{ opacity: 1, y: 0, rotate: 0 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await requestJson(LoginResponse, "/api/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code, name, phone }),
            });
            const nextSession = await requestJson(
              SessionResponse,
              `/api/session?code=${encodeURIComponent(code)}`,
            );
            onLogin(nextSession);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not join gallery.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-xs font-black uppercase tracking-[0.16em] text-stone-500">
          Wedding camera
        </p>
        <h1 className="font-serif text-[clamp(3.2rem,16vw,5.4rem)] leading-[0.82]">
          Scan. Join. Shoot.
        </h1>
        <Field label="Room code" value={code} onChange={setCode} />
        <Field label="Your name" value={name} autoComplete="name" onChange={setName} />
        <Field label="Phone" value={phone} type="tel" autoComplete="tel" onChange={setPhone} />
        {error ? (
          <p className="rounded-2xl bg-orange-100 p-3 font-black text-red-800">{error}</p>
        ) : null}
        <Button disabled={busy} type="submit">
          Enter camera
        </Button>
      </motion.form>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-2 font-black text-stone-950/70">
      {label}
      <input
        className="w-full rounded-2xl border border-stone-950/15 bg-white px-4 py-3 text-stone-950 outline-none transition focus:border-stone-950/40 focus:ring-4 focus:ring-amber-300/40"
        value={value}
        type={type}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.currentTarget.value)}
        required
      />
    </label>
  );
}

function UserMenu({ name, onSignOut }: { name: string; onSignOut: () => Promise<void> }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <Popover.Root>
      <Popover.Trigger className="grid size-11 place-items-center justify-self-end rounded-full bg-white font-black text-stone-950 shadow-lg md:col-start-3">
        {initials || "U"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={10}>
          <Popover.Popup className="grid min-w-48 gap-2 rounded-2xl border border-stone-200 bg-white p-2 text-stone-950 shadow-xl outline-none">
            <div className="px-3 py-2">
              <p className="text-xs font-black uppercase tracking-wide text-stone-500">
                Signed in as
              </p>
              <p className="font-black">{name}</p>
            </div>
            <button
              className="rounded-xl px-3 py-2 text-left font-black text-red-700 transition hover:bg-red-50"
              type="button"
              onClick={() => void onSignOut()}
            >
              Sign out
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function GalleryView({
  tab,
  photos,
  personalCount,
  allCount,
  onBack,
  onOpenPhoto,
  onTabChange,
  onRemove,
}: {
  tab: Tab;
  photos: ReadonlyArray<GalleryPhoto>;
  personalCount: number;
  allCount: number;
  onBack: () => void;
  onOpenPhoto: (photo: GalleryPhoto) => void;
  onTabChange: (tab: Tab) => void;
  onRemove: (photo: GalleryPhoto) => void;
}) {
  return (
    <main className="min-h-screen overflow-y-auto bg-stone-100 p-4 text-stone-950 md:p-8">
      <header className="mx-auto mb-8 flex w-full max-w-6xl items-center justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-stone-500">
            Wedding roll
          </p>
          <h1 className="font-serif text-4xl leading-none md:text-6xl">Gallery</h1>
        </div>
        <Button className="shadow-none" type="button" onClick={onBack}>
          Camera
        </Button>
      </header>

      <section className="mx-auto w-full max-w-6xl">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as Tab)}>
          <TabsList className="mb-6 max-w-sm rounded-full bg-white p-1 shadow-none">
            <TabsTrigger value="all">All {allCount}</TabsTrigger>
            <TabsTrigger value="personal">Yours {personalCount}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <AnimatePresence initial={false}>
            {photos.length === 0 ? (
              <motion.div
                className="col-span-full grid min-h-64 place-items-center border border-dashed border-stone-300 p-8 text-center font-serif text-3xl font-black text-stone-950/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                No shots yet
              </motion.div>
            ) : (
              photos.map((photo, index) => (
                <PolaroidCard
                  key={photo.id}
                  photo={photo}
                  index={index}
                  onOpen={onOpenPhoto}
                  onRemove={onRemove}
                />
              ))
            )}
          </AnimatePresence>
        </div>
      </section>
    </main>
  );
}

function PolaroidCard({
  photo,
  index,
  onOpen,
  onRemove,
}: {
  photo: GalleryPhoto;
  index: number;
  onOpen: (photo: GalleryPhoto) => void;
  onRemove: (photo: GalleryPhoto) => void;
}) {
  return (
    <motion.article
      className="touch-pan-y bg-amber-50 p-2 pb-4 text-stone-950 shadow-sm ring-1 ring-stone-200/80"
      layout
      drag={photo.isMine ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.25}
      initial={{ opacity: 0, y: 20, rotate: 0 }}
      animate={{ opacity: 1, y: 0, rotate: index % 2 === 0 ? -1.5 : 1.5 }}
      exit={{ opacity: 0, scale: 0.96 }}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 120) onRemove(photo);
      }}
    >
      <button className="block w-full" type="button" onClick={() => onOpen(photo)}>
        <ViewTransition name={`photo-${photo.id}`}>
          <img
            className="aspect-square w-full rounded-sm object-cover"
            src={photo.url}
            alt={photo.filename}
          />
        </ViewTransition>
      </button>
      <footer className="grid gap-0.5 px-0.5 pt-2 font-serif">
        <span className="truncate font-black">{photo.guestName}</span>
        <small className="text-[0.68rem] font-black uppercase text-stone-950/55">
          {photo.isMine ? "Swipe to toss" : "Guest roll"}
        </small>
      </footer>
    </motion.article>
  );
}

function PhotoDetailView({
  photo,
  onBack,
  onRemove,
}: {
  photo: GalleryPhoto;
  onBack: () => void;
  onRemove: (photo: GalleryPhoto) => void;
}) {
  return (
    <main className="min-h-screen bg-stone-950 p-4 text-white md:p-8">
      <header className="mx-auto mb-6 flex max-w-6xl items-center justify-between gap-4">
        <Button
          className="bg-white text-stone-950 shadow-none hover:bg-stone-100"
          type="button"
          onClick={onBack}
        >
          Gallery
        </Button>
        {photo.isMine ? (
          <Button
            className="bg-white text-red-700 shadow-none hover:bg-red-50"
            type="button"
            onClick={() => {
              onRemove(photo);
              onBack();
            }}
          >
            Remove
          </Button>
        ) : null}
      </header>

      <section className="mx-auto grid max-w-6xl gap-5 md:grid-cols-[1fr_280px] md:items-start">
        <ViewTransition name={`photo-${photo.id}`}>
          <img
            className="max-h-[78vh] w-full bg-black object-contain"
            src={photo.url}
            alt={photo.filename}
          />
        </ViewTransition>
        <aside className="grid gap-2 text-white/80">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-white/45">Photo by</p>
          <h1 className="font-serif text-4xl leading-none text-white">{photo.guestName}</h1>
          <p className="break-all text-sm font-bold text-white/55">{photo.filename}</p>
        </aside>
      </section>
    </main>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.button
      className={cn(
        "fixed bottom-6 right-6 z-20 max-w-[min(420px,calc(100vw-48px))] rounded-2xl border border-white/20 bg-orange-50 px-4 py-3 text-left font-black text-red-800 shadow-2xl",
      )}
      type="button"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      onClick={onClose}
    >
      {message}
    </motion.button>
  );
}
