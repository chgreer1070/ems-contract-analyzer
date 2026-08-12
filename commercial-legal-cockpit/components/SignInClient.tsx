"use client";

import { authClient } from "@/lib/auth-client";

export default function SignInClient({callbackURL}:{callbackURL:string}){
  return <button className="primary" onClick={()=>authClient.signIn.social({provider:"microsoft",callbackURL})}>Sign in with Microsoft</button>;
}
