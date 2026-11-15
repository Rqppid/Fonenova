import { redirect } from 'next/navigation'

/** Settings lives on the home page (#settings): /settings used to be a 404, now it lands there. */
export default function SettingsRedirect(): never {
  redirect('/#settings')
}
