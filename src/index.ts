/**********************************************************************
Image: A very simple online image hosting service
Copyright (C) 2025  langningchen

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
**********************************************************************/

import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
    auth: process.env.GITHUB_PAT,
});

async function uploadToGitHub(imageData: string, imageID: string): Promise<string> {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const path = `${imageID}.jpeg`;
    const content = Buffer.from(imageData, 'base64').toString('base64');

    try {
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path,
            message: `Upload image ${imageID}`,
            content,
        });
        return imageID;
    } catch (error) {
        console.log(error);
        return '';
    }
}

async function getFromGitHub(imageID: string): Promise<Response> {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const path = `${imageID}.jpeg`;

    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path,
        });
        const content = Buffer.from(data.content, 'base64');
        return new Response(content, { headers: { 'Content-Type': 'image/jpeg' } });
    } catch (error) {
        console.log(error);
        return new Response('', { status: 404 });
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
        if (request.method == 'POST' && new URL(request.url).pathname == '/upload') {
            const Image: string = await request.text();
            let ImageID: string = '';
            for (let i = 0; i < 32; i++) {
                ImageID += String.fromCharCode(Math.floor(Math.random() * 26) + 97);
            }
            const ImageData = Image.replace(/^data:image\/\w+;base64,/, '');
            return new Response(await uploadToGitHub(ImageData, ImageID));
        }
        else if (request.method == 'GET') {
            const ImageID = new URL(request.url).pathname.substring(1);
            if (ImageID == '') { return new Response('', { status: 404, }); }
            return await getFromGitHub(ImageID);
        }
        return new Response('404');
    },
};
