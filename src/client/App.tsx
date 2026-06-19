import { AnimatePresence, motion } from "motion/react";
import { startTransition, useEffect, useRef, useState } from "react";

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

  if (!session) return <main className="loading">Loading camera...</main>;
  if (!session.guest)
    return <Login initialCode={session.eventCode || queryCode()} onLogin={setSession} />;

  return (
    <main className="camera-app">
      <div className="grain" />
      <section className="viewfinder" aria-label="Wedding camera">
        <header className="camera-top">
          <div>
            <span className="rec-dot" /> Live wedding roll
          </div>
          <button
            className="text-button"
            type="button"
            onClick={async () => {
              await requestJson("/api/logout", { method: "POST" });
              setSession({ guest: null, eventCode: queryCode(), maxPhotos: 20 });
            }}
          >
            Sign out
          </button>
        </header>

        <div className="focus-ring">
          <span />
          <span />
          <span />
          <span />
        </div>

        <motion.div
          className="camera-copy"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p>{session.guest.name}'s camera</p>
          <h1>Catch a real moment.</h1>
        </motion.div>

        <input
          ref={inputRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          disabled={busy || remaining === 0}
          onChange={(event) => void upload(event.currentTarget.files)}
        />

        <footer className="camera-controls">
          <motion.div className="counter" layout aria-live="polite">
            <span>left</span>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.strong
                key={remaining}
                initial={{ y: 18, opacity: 0, scale: 0.8 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: -18, opacity: 0, scale: 0.8 }}
              >
                {remaining}
              </motion.strong>
            </AnimatePresence>
          </motion.div>

          <motion.button
            className="shutter"
            type="button"
            disabled={busy || remaining === 0}
            whileTap={{ scale: 0.86 }}
            onClick={() => inputRef.current?.click()}
            aria-label="Take or choose photo"
          >
            <span />
          </motion.button>

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
    <main className="login-camera">
      <motion.form
        className="login-card"
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
        <p className="kicker">Wedding camera</p>
        <h1>Scan. Join. Shoot.</h1>
        <label>
          Room code
          <input value={code} onChange={(event) => setCode(event.currentTarget.value)} required />
        </label>
        <label>
          Your name
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoComplete="name"
            required
          />
        </label>
        <label>
          Phone
          <input
            value={phone}
            onChange={(event) => setPhone(event.currentTarget.value)}
            autoComplete="tel"
            type="tel"
            required
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button disabled={busy} type="submit">
          Enter camera
        </button>
      </motion.form>
    </main>
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
    <aside className="gallery-tray" aria-label="Gallery">
      <div className="tabs">
        <button
          className={tab === "all" ? "active" : ""}
          type="button"
          onClick={() => onTabChange("all")}
        >
          All {allCount}
        </button>
        <button
          className={tab === "personal" ? "active" : ""}
          type="button"
          onClick={() => onTabChange("personal")}
        >
          Yours {personalCount}
        </button>
      </div>

      <div className="polaroid-stack">
        <AnimatePresence initial={false}>
          {photos.length === 0 ? (
            <motion.div
              className="empty-polaroid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              No shots yet
            </motion.div>
          ) : (
            photos.slice(0, 8).map((photo, index) => (
              <motion.article
                className="polaroid"
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
                <img src={photo.url} alt={photo.filename} />
                <footer>
                  <span>{photo.guestName}</span>
                  {photo.isMine ? <small>Swipe to toss</small> : <small>Guest roll</small>}
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
      className="toast"
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
