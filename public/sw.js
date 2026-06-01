self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Gold Barber",
      body: "Nova atualização de agendamento."
    };
  }

  const title = data.title || "Gold Barber";

  const options = {
    body: data.body || "Nova atualização.",
    icon: "/img/icon-192.png",
    badge: "/img/icon-192.png",
    tag: data.tag || "goldbarber-notification",
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || "/admin"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification?.data?.url || "/admin";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if (client.url !== url && "navigate" in client) {
            return client.navigate(url);
          }
          return;
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});