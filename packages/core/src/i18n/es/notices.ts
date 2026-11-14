/**
 * Notifications to the team, by their English shape (patterns.ts): the bell, push, email and texts
 * show them in the reader's language. The English is exactly what the database writes (the
 * function each comes from is named above it); packages/core/test/i18n.test.ts reads real ones.
 * The more particular shape of two goes first.
 */
import type { PatternTable } from "../patterns";

export const NOTICES: PatternTable = [
  // A crew member's schedule (private.notify_schedule, its callers and private.visit_when)
  ["{count} changes to your schedule", "{count} cambios en tu agenda"],
  ["You're on {title}: {when}", "Te pusieron en {title}: {when}"],
  ["You're off {title} ({when})", "Te quitaron de {title} ({when})"],
  ["{title} on {when} was cancelled", "Se canceló {title} del {when}"],
  ["{title} is off the schedule for now (was {was})", "{title} salió de la agenda por ahora (era el {was})"],
  ["{title} moved to {when} (was {was})", "{title} se movió al {when} (era el {was})"],
  ["{title} now starts {when}", "{title} ahora empieza el {when}"],
  ["The upcoming visits for job #{number} ({title}) changed", "Cambiaron las próximas visitas del trabajo #{number} ({title})"],

  // The clock (public.clock_upkeep)
  ["Your clock was stopped for you", "Tu reloj se paró solo"],
  ["It had been running since {time}, so it was stopped at {time2}. Fix the end time on Timesheets if that's wrong.", "Estaba corriendo desde las {time}, así que se paró a las {time2}. Corrige la hora de salida en Hojas de horas si no está bien."],
  ["It started at {time} and was still running, so it was stopped at {time2}. Fix the end time on Timesheets if that's wrong.", "Empezó a las {time} y seguía corriendo, así que se paró a las {time2}. Corrige la hora de salida en Hojas de horas si no está bien."],
  ["Your clock is still running", "Tu reloj sigue corriendo"],
  ["{name}'s clock is still running", "El reloj de {name} sigue corriendo"],
  ["On the clock since {time}, {hours} hours ago. Stop it if the day is done.", "En el reloj desde las {time}, hace {hours} horas. Páralo si ya terminó el día."],
  ["Started at {time}, {hours} hours ago. Stop it if the day is done.", "Empezó a las {time}, hace {hours} horas. Páralo si ya terminó el día."],

  // Team chat (private.chat_notify_mentions)
  ["{name} mentioned you in {where}", "{name} te mencionó en {where}"],
  ["{name} posted in {where}", "{name} publicó en {where}"],
  ["Sent a photo", "Envió una foto"],

  // A sub's job offers and pay (private.sub_offer_told, private.job_pay_sub_notices)
  ["New price for {job}: {price} (was {old}). Answer by {when}. Open Crewtavo to accept or decline.", "Precio nuevo para {job}: {price} (antes {old}). Responde antes del {when}. Abre Crewtavo para aceptar o rechazar."],
  ["New price for {job}: {price} (was {old}). Open Crewtavo to accept or decline.", "Precio nuevo para {job}: {price} (antes {old}). Abre Crewtavo para aceptar o rechazar."],
  ["{line}. Answer by {when}. Open Crewtavo to accept or decline.", "{line}. Responde antes del {when}. Abre Crewtavo para aceptar o rechazar."],
  ["{line}. Open Crewtavo to accept or decline.", "{line}. Abre Crewtavo para aceptar o rechazar."],
  ["New job offer.", "Nueva oferta de trabajo."],
  ["If you don't accept it, the price you agreed stands.", "Si no lo aceptas, se queda el precio que acordaron."],
  ["The new price for {job} was withdrawn", "Se retiró el precio nuevo para {job}"],
  ["The offer for {job} was withdrawn", "Se retiró la oferta para {job}"],
  ["The price you agreed ({price}) stands.", "Se queda el precio que acordaron ({price})."],
  ["You don't need to do anything.", "No tienes que hacer nada."],
  ["Your price for {job} is now {price} (was {old})", "Tu precio para {job} ahora es {price} (antes {old})"],
  ["{job} is yours at {price}", "{job} es tuyo por {price}"],
  ["The office agreed the new price with you.", "La oficina acordó contigo el precio nuevo."],
  ["The office agreed it with you. It's on My day.", "La oficina lo acordó contigo. Ya está en Mi día."],
  ["Owed: {amount} for {job}", "Pendiente: {amount} por {job}"],
  ["The work's done. We'll let you know when it's paid.", "El trabajo está terminado. Te avisamos cuando se pague."],
  ["Paid {amount} on {date}", "Pagado {amount} el {date}"],
  ["{job}, by check.", "{job}, con cheque."],
  ["{job}, by bank transfer.", "{job}, por transferencia bancaria."],
  ["{job}, in cash.", "{job}, en efectivo."],
  ["{job}, by card or payment app.", "{job}, con tarjeta o aplicación de pago."],
  ["{job}, through payroll.", "{job}, por nómina."],

  // A sub's paperwork running out (public.emit_sub_document_alerts)
  ["Your {wordDoc} has run out", "Tu {wordDoc} venció"],
  ["Your {wordDoc} ends today", "Tu {wordDoc} vence hoy"],
  ["Your {wordDoc} ends tomorrow", "Tu {wordDoc} vence mañana"],
  ["Your {wordDoc} ends in {days} days", "Tu {wordDoc} vence en {days} días"],
  ["It ended {date}. Send us the new one under My paperwork.", "Venció el {date}. Envíanos el nuevo en Mis documentos."],
  ["It ends {date}. Send us the new one under My paperwork.", "Vence el {date}. Envíanos el nuevo en Mis documentos."],

  // A crew lead's crew's machines (public.emit_equipment_alerts)
  ["{plan} is overdue on {machine}", "{plan} está atrasado en {machine}"],
  ["{plan} is coming due on {machine}", "{plan} ya casi toca en {machine}"],
  ["Due {date} or at {reading} {wordMeter} (now {now})", "Toca el {date} o al llegar a {reading} {wordMeter} (ahora {now})"],
  ["Due {date} or at {reading} {wordMeter}", "Toca el {date} o al llegar a {reading} {wordMeter}"],
  ["Due at {reading} {wordMeter} (now {now})", "Toca al llegar a {reading} {wordMeter} (ahora {now})"],
  ["Due at {reading} {wordMeter}", "Toca al llegar a {reading} {wordMeter}"],
  ["Due {date}", "Toca el {date}"],

  // A client asking to move or cancel, told to the crew lead (private.visit_change_requested)
  ["{client} asked to cancel {title}", "{client} pidió cancelar {title}"],
  ["{client} asked to move {title}", "{client} pidió mover {title}"],
  ["Booked {when}. Reason: {reason}", "Programada el {when}. Motivo: {reason}"],
  ["Booked {when}. No reason given.", "Programada el {when}. No dio motivo."],
  ["Booked {when}. Asked for {when2}.", "Programada el {when}. Pidió el {when2}."],
  ["Booked {when}. {message}", "Programada el {when}. {message}"],

  // Plans added to a job the crew works on (private.plan_files_notify)
  ["New version of {file} for job #{number} ({title}): {revision}", "Nueva versión de {file} para el trabajo #{number} ({title}): {revision}"],
  ["New version of {file} for job #{number} ({title})", "Nueva versión de {file} para el trabajo #{number} ({title})"],
  ["{file} added to job #{number} ({title})", "Se agregó {file} al trabajo #{number} ({title})"],
];

/** Words the database drops into those sentences (private.sub_document_words, equipment meters). */
export const NOTICE_WORDS: Record<string, string> = {
  "W-9": "W-9",
  "liability insurance": "seguro de responsabilidad civil",
  "workers' comp certificate": "certificado de compensación laboral",
  "workers' comp exemption": "exención de compensación laboral",
  license: "licencia",
  document: "documento",
  hours: "horas",
  miles: "millas",
};
