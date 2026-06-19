import { AnimatePresence, motion } from "motion/react";
import QRCode from "qrcode";
import { startTransition, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { cn } from "./lib/utils";

type Guest = { id: string; name: string; phone: string };
type Session = { guest: Guest | null; eventCode: string; maxPhotos: number; remaining?: number };
type Photo = {
  id: string;
  guestName: string;
  filename: string;
  createdAt: string;
  isMine: boolean;
  url: string;
};
type Tab = "all" | "personal";
type CreatedRoom = { event: { id: string; name: string; code: string }; joinUrl: string };

const requestJson = async <T,>(input: RequestInfo, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
};

const queryCode = () => new URLSearchParams(window.location.search).get("code") ?? "";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  if (window.location.pathname === "/admin") {
    return <Admin />;
  }

  const remaining = session?.remaining ?? session?.maxPhotos ?? 20;
  const visiblePhotos = tab === "personal" ? photos.filter((photo) => photo.isMine) : photos;

  const refresh = async (nextTab = tab) => {
    const [{ photos: nextPhotos }, nextSession] = await Promise.all([
      requestJson<{ photos: Photo[] }>(`/api/gallery?scope=${nextTab}`),
      requestJson<Session>(`/api/session?code=${encodeURIComponent(queryCode())}`),
    ]);
    startTransition(() => {
      setPhotos(nextPhotos);
      setSession(nextSession);
    });
  };

  useEffect(() => {
    requestJson<Session>(`/api/session?code=${encodeURIComponent(queryCode())}`)
      .then((nextSession) => {
        setSession(nextSession);
        if (nextSession.guest) return refresh();
        return undefined;
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError("");

    try {
      const body = new FormData();
      [...files].forEach((file) => body.append("photos", file));
      await requestJson<{ remaining: number }>("/api/upload", { method: "POST", body });
      await refresh(tab);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload photo.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const removePhoto = async (photo: Photo) => {
    if (!photo.isMine) return;
    setPhotos((current) => current.filter((item) => item.id !== photo.id));
    try {
      await requestJson<{ ok: boolean }>(`/api/photos/${photo.id}`, { method: "DELETE" });
      await refresh(tab);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove photo.");
      await refresh(tab);
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

  return (
    <main className="relative min-h-screen overflow-hidden bg-black p-0 text-stone-50 md:bg-stone-200 md:p-5">
      <section className="relative mx-auto grid h-dvh w-full grid-rows-[auto_1fr_auto] overflow-hidden bg-black shadow-2xl md:h-[calc(100vh-40px)] md:max-w-[1180px] md:rounded-[36px] md:border-[10px] md:border-stone-950">
        <header className="z-10 grid grid-cols-[1fr_auto] items-center gap-4 p-4 text-xs font-black uppercase tracking-[0.12em] text-amber-50/80 md:grid-cols-[1fr_auto_1fr] md:p-6">
          <div>
            <span className="mr-2 inline-block size-2.5 rounded-full bg-red-500 shadow-[0_0_18px_#ef4444]" />
            Live wedding roll
          </div>
          <Button
            className="justify-self-end md:col-start-3"
            variant="ghost"
            type="button"
            onClick={async () => {
              await requestJson("/api/logout", { method: "POST" });
              setSession({ guest: null, eventCode: queryCode(), maxPhotos: 20 });
            }}
          >
            Sign out
          </Button>
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

        <footer className="z-10 grid grid-cols-[1fr_auto_1fr] items-end gap-3 p-4 md:p-6">
          <motion.div
            className="grid min-w-20 grid-cols-[auto_auto] items-end gap-2 justify-self-start rounded-[22px] border border-white/20 bg-stone-950 px-3 py-2 md:min-w-28 md:px-4 md:py-3"
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

          <motion.div whileTap={{ scale: 0.86 }}>
            <Button
              variant="shutter"
              type="button"
              disabled={busy || remaining === 0}
              onClick={() => inputRef.current?.click()}
              aria-label="Take or choose photo"
            >
              <span className="size-12 rounded-full bg-amber-50 md:size-14" />
            </Button>
          </motion.div>

          <GalleryTray
            tab={tab}
            photos={visiblePhotos}
            personalCount={photos.filter((photo) => photo.isMine).length}
            allCount={tab === "all" ? photos.length : visiblePhotos.length}
            onTabChange={(nextTab) => {
              setTab(nextTab);
              void refresh(nextTab);
            }}
            onRemove={removePhoto}
          />
        </footer>
      </section>
      <AnimatePresence>
        {error ? <Toast message={error} onClose={() => setError("")} /> : null}
      </AnimatePresence>
    </main>
  );
}

function Admin() {
  const [adminPin, setAdminPin] = useState("");
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
              const room = await requestJson<CreatedRoom>("/api/admin/events", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ adminPin, name, code }),
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
          <AdminField label="Admin PIN" value={adminPin} type="password" onChange={setAdminPin} />
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
            await requestJson("/api/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code, name, phone }),
            });
            const nextSession = await requestJson<Session>(
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

function GalleryTray({
  tab,
  photos,
  personalCount,
  allCount,
  onTabChange,
  onRemove,
}: {
  tab: Tab;
  photos: Photo[];
  personalCount: number;
  allCount: number;
  onTabChange: (tab: Tab) => void;
  onRemove: (photo: Photo) => void;
}) {
  return (
    <aside className="w-[122px] justify-self-end md:w-[min(330px,32vw)]" aria-label="Gallery">
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as Tab)}>
        <TabsList className="mb-3 grid-cols-1 md:grid-cols-2">
          <TabsTrigger value="all">All {allCount}</TabsTrigger>
          <TabsTrigger value="personal">Yours {personalCount}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid auto-cols-[108px] grid-flow-col gap-3 overflow-x-auto pb-3 [scrollbar-width:none] md:auto-cols-[minmax(116px,1fr)] [&::-webkit-scrollbar]:hidden">
        <AnimatePresence initial={false}>
          {photos.length === 0 ? (
            <motion.div
              className="grid min-h-36 place-items-center rounded-md bg-amber-50 p-5 font-serif font-black text-stone-950/60 shadow-2xl md:min-h-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              No shots yet
            </motion.div>
          ) : (
            photos.slice(0, 8).map((photo, index) => (
              <motion.article
                className="min-h-36 touch-pan-y rounded-md bg-amber-50 p-2 pb-3 text-stone-950 shadow-2xl md:min-h-40"
                key={photo.id}
                layout
                drag={photo.isMine ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.35}
                initial={{ opacity: 0, y: 30, rotate: 5 }}
                animate={{ opacity: 1, y: 0, rotate: index % 2 === 0 ? -2 : 2 }}
                exit={{ opacity: 0, x: 180, rotate: 15 }}
                onDragEnd={(_, info) => {
                  if (Math.abs(info.offset.x) > 120) onRemove(photo);
                }}
              >
                <img
                  className="aspect-square w-full rounded-sm object-cover"
                  src={photo.url}
                  alt={photo.filename}
                />
                <footer className="grid gap-0.5 px-0.5 pt-2 font-serif">
                  <span className="truncate font-black">{photo.guestName}</span>
                  <small className="text-[0.68rem] font-black uppercase text-stone-950/55">
                    {photo.isMine ? "Swipe to toss" : "Guest roll"}
                  </small>
                </footer>
              </motion.article>
            ))
          )}
        </AnimatePresence>
      </div>
    </aside>
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
